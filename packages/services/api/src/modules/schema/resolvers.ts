import { createHash } from 'crypto';
import stringify from 'fast-json-stable-stringify';
import {
  buildASTSchema,
  GraphQLError,
  GraphQLNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  type DocumentNode,
} from 'graphql';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import { z } from 'zod';
import { ProjectType, type DateRange } from '../../shared/entities';
import { createPeriod, parseDateRangeInput, PromiseOrValue } from '../../shared/helpers';
import type {
  GraphQLEnumTypeMapper,
  GraphQLInputObjectTypeMapper,
  GraphQLInterfaceTypeMapper,
  GraphQLObjectTypeMapper,
  GraphQLScalarTypeMapper,
  GraphQLUnionTypeMapper,
  SchemaCompareError,
  SchemaCompareResult,
  WithGraphQLParentInfo,
  WithSchemaCoordinatesUsage,
} from '../../shared/mappers';
import { buildSchema, createConnection, createDummyConnection } from '../../shared/schema';
import { AuthManager } from '../auth/providers/auth-manager';
import { OperationsManager } from '../operations/providers/operations-manager';
import { OrganizationManager } from '../organization/providers/organization-manager';
import { ProjectManager } from '../project/providers/project-manager';
import { IdTranslator } from '../shared/providers/id-translator';
import { TargetSelector } from '../shared/providers/storage';
import { TargetManager } from '../target/providers/target-manager';
import type { SchemaModule } from './__generated__/types';
import {
  extractSuperGraphInformation,
  type SuperGraphInformation,
} from './lib/federation-super-graph';
import { Inspector, toGraphQLSchemaChange } from './providers/inspector';
import { SchemaBuildError } from './providers/orchestrators/errors';
import { detectUrlChanges } from './providers/registry-checks';
import { ensureSDL, SchemaHelper } from './providers/schema-helper';
import { SchemaManager } from './providers/schema-manager';
import { SchemaPublisher } from './providers/schema-publisher';
import { schemaChangeFromMeta, SerializableChange } from './schema-change-from-meta';
import { toGraphQLSchemaCheck, toGraphQLSchemaCheckCurry } from './to-graphql-schema-check';

const MaybeModel = <T extends z.ZodType>(value: T) => z.union([z.null(), z.undefined(), value]);
const GraphQLSchemaStringModel = z.string().max(5_000_000).min(0);

async function usage(
  source:
    | WithSchemaCoordinatesUsage<{
        entity: {
          name: string;
        };
      }>
    | WithGraphQLParentInfo<
        WithSchemaCoordinatesUsage<{
          entity: {
            name: string;
          };
        }>
      >,
  _: unknown,
) {
  const coordinate =
    'parent' in source ? `${source.parent.coordinate}.${source.entity.name}` : source.entity.name;
  const usage = (await source.usage)[coordinate];

  return usage
    ? {
        total: usage.total,
        isUsed: usage.total > 0,
        get usedByClients() {
          return usage.usedByClients;
        },
      }
    : {
        total: 0,
        isUsed: false,
        usedByClients: null,
      };
}

function __isTypeOf<T extends GraphQLNamedType>(isFn: (entity: GraphQLNamedType) => entity is T) {
  return ({ entity }: { entity: GraphQLNamedType }) => isFn(entity);
}

export const resolvers: SchemaModule.Resolvers = {
  Mutation: {
    async schemaCheck(_, { input }, { injector }) {
      const [organization, project, target] = await Promise.all([
        injector.get(OrganizationManager).getOrganizationIdByToken(),
        injector.get(ProjectManager).getProjectIdByToken(),
        injector.get(TargetManager).getTargetIdByToken(),
      ]);

      const result = await injector.get(SchemaPublisher).check({
        ...input,
        service: input.service?.toLowerCase(),
        organization,
        project,
        target,
      });

      if ('changes' in result) {
        return {
          ...result,
          changes: result.changes.map(toGraphQLSchemaChange),
          errors:
            result.errors?.map(error => ({
              ...error,
              path: 'path' in error ? error.path?.split('.') : null,
            })) ?? [],
        };
      }

      return result;
    },
    async approveFailedSchemaCheck(_, { input }, { injector }) {
      const [organizationId, projectId, targetId] = await Promise.all([
        injector.get(IdTranslator).translateOrganizationId(input),
        injector.get(IdTranslator).translateProjectId(input),
        injector.get(IdTranslator).translateTargetId(input),
      ]);

      const result = await injector.get(SchemaManager).approveFailedSchemaCheck({
        organizationId,
        projectId,
        targetId,
        schemaCheckId: input.schemaCheckId,
      });

      if (result.type === 'error') {
        return {
          error: {
            message: result.reason,
          },
        };
      }

      return {
        ok: {
          schemaCheck: toGraphQLSchemaCheck(
            {
              organizationId,
              projectId,
            },
            result.schemaCheck,
          ),
        },
      };
    },
    async schemaPublish(_, { input }, { injector, abortSignal }, info) {
      const [organization, project, target] = await Promise.all([
        injector.get(OrganizationManager).getOrganizationIdByToken(),
        injector.get(ProjectManager).getProjectIdByToken(),
        injector.get(TargetManager).getTargetIdByToken(),
      ]);
      const token = injector.get(AuthManager).ensureApiToken();

      const checksum = createHash('md5')
        .update(
          stringify({
            ...input,
            organization,
            project,
            target,
            service: input.service?.toLowerCase(),
          }),
        )
        .update(token)
        .digest('base64');

      // We only want to resolve to SchemaPublishMissingUrlError if it is selected by the operation.
      // NOTE: This should be removed once the usage of cli versions that don't request on 'SchemaPublishMissingUrlError' is becomes pretty low.
      const parsedResolveInfoFragment = parseResolveInfo(info);
      const isSchemaPublishMissingUrlErrorSelected =
        !!parsedResolveInfoFragment?.fieldsByTypeName['SchemaPublishMissingUrlError'];

      const result = await injector.get(SchemaPublisher).publish(
        {
          ...input,
          service: input.service?.toLowerCase(),
          checksum,
          organization,
          project,
          target,
          isSchemaPublishMissingUrlErrorSelected,
        },
        abortSignal,
      );

      if ('changes' in result) {
        return {
          ...result,
          changes: result.changes?.map(toGraphQLSchemaChange),
        };
      }

      return result;
    },
    async schemaDelete(_, { input }, { injector, abortSignal }) {
      const [organization, project, target] = await Promise.all([
        injector.get(OrganizationManager).getOrganizationIdByToken(),
        injector.get(ProjectManager).getProjectIdByToken(),
        injector.get(TargetManager).getTargetFromToken(),
      ]);

      const token = injector.get(AuthManager).ensureApiToken();

      const checksum = createHash('md5')
        .update(
          stringify({
            ...input,
            serviceName: input.serviceName.toLowerCase(),
          }),
        )
        .update(token)
        .digest('base64');

      const result = await injector.get(SchemaPublisher).delete(
        {
          dryRun: input.dryRun,
          serviceName: input.serviceName.toLowerCase(),
          organization,
          project,
          target,
          checksum,
        },
        abortSignal,
      );

      return {
        ...result,
        changes: result.changes?.map(toGraphQLSchemaChange),
        errors: result.errors?.map(error => ({
          ...error,
          path: 'path' in error ? error.path?.split('.') : null,
        })),
      };
    },
    async updateSchemaVersionStatus(_, { input }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project, target] = await Promise.all([
        translator.translateOrganizationId(input),
        translator.translateProjectId(input),
        translator.translateTargetId(input),
      ]);

      return injector.get(SchemaPublisher).updateVersionStatus({
        version: input.version,
        valid: input.valid,
        organization,
        project,
        target,
      });
    },
    async updateBaseSchema(_, { input }, { injector }) {
      const UpdateBaseSchemaModel = z.object({
        newBase: MaybeModel(GraphQLSchemaStringModel),
      });

      const result = UpdateBaseSchemaModel.safeParse(input);

      if (!result.success) {
        return {
          error: {
            message:
              result.error.formErrors.fieldErrors?.newBase?.[0] ?? 'Please check your input.',
          },
        };
      }

      const schemaManager = injector.get(SchemaManager);
      const translator = injector.get(IdTranslator);
      const [organization, project, target] = await Promise.all([
        translator.translateOrganizationId(input),
        translator.translateProjectId(input),
        translator.translateTargetId(input),
      ]);

      const selector = { organization, project, target };
      await schemaManager.updateBaseSchema(selector, input.newBase ? input.newBase : null);

      return {
        ok: {
          updatedTarget: await injector.get(TargetManager).getTarget({
            organization,
            target,
            project,
          }),
        },
      };
    },
    async disableExternalSchemaComposition(_, { input }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project] = await Promise.all([
        translator.translateOrganizationId(input),
        translator.translateProjectId(input),
      ]);

      return injector.get(SchemaManager).disableExternalSchemaComposition({
        project,
        organization,
      });
    },
    async enableExternalSchemaComposition(_, { input }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project] = await Promise.all([
        translator.translateOrganizationId(input),
        translator.translateProjectId(input),
      ]);

      return injector.get(SchemaManager).enableExternalSchemaComposition({
        project,
        organization,
        endpoint: input.endpoint,
        secret: input.secret,
      });
    },
    async updateProjectRegistryModel(_, { input }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project] = await Promise.all([
        translator.translateOrganizationId(input),
        translator.translateProjectId(input),
      ]);

      return injector.get(SchemaManager).updateRegistryModel({
        project,
        organization,
        model: input.model,
      });
    },
  },
  Query: {
    async schemaCompareToPrevious(_, { selector, unstable_forceLegacyComparison }, { injector }) {
      const translator = injector.get(IdTranslator);
      const schemaManager = injector.get(SchemaManager);
      const projectManager = injector.get(ProjectManager);
      const organizationManager = injector.get(OrganizationManager);
      const helper = injector.get(SchemaHelper);

      const [organizationId, projectId, targetId] = await Promise.all([
        translator.translateOrganizationId(selector),
        translator.translateProjectId(selector),
        translator.translateTargetId(selector),
      ]);

      const [project, organization] = await Promise.all([
        projectManager.getProject({
          organization: organizationId,
          project: projectId,
        }),
        organizationManager.getOrganization({
          organization: organizationId,
        }),
      ]);

      const useLegacy = unstable_forceLegacyComparison ?? false;
      const isCompositeModernProject =
        project.legacyRegistryModel === false &&
        (project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING);

      // Lord forgive me for my sins
      if (useLegacy === false) {
        const currentVersion = await schemaManager.getSchemaVersion({
          organization: organizationId,
          project: projectId,
          target: targetId,
          version: selector.version,
        });

        if (currentVersion.schemaCompositionErrors) {
          return {
            error: new SchemaBuildError(
              'Composition error',
              currentVersion.schemaCompositionErrors,
            ),
          } as SchemaCompareError;
        }

        const previousVersion = currentVersion.previousSchemaVersionId
          ? await schemaManager.getSchemaVersion({
              organization: organizationId,
              project: projectId,
              target: targetId,
              version: currentVersion.previousSchemaVersionId,
            })
          : null;

        if (currentVersion.compositeSchemaSDL && previousVersion === null) {
          return {
            result: {
              schemas: {
                before: null,
                current: currentVersion.compositeSchemaSDL,
              },
              changes: [],
              versionIds: isCompositeModernProject
                ? {
                    before: null,
                    current: currentVersion.id,
                  }
                : null,
            },
          } satisfies SchemaCompareResult;
        }

        const getBeforeSchemaSDL = async () => {
          const orchestrator = schemaManager.matchOrchestrator(project.type);

          const { schemas: schemasBefore } = await schemaManager.getSchemasOfPreviousVersion({
            organization: organizationId,
            project: projectId,
            target: targetId,
            version: selector.version,
            onlyComposable: organization.featureFlags.compareToPreviousComposableVersion === true,
          });

          if (schemasBefore.length === 0) {
            return null;
          }
          const { raw } = await ensureSDL(
            orchestrator.composeAndValidate(
              schemasBefore.map(s => helper.createSchemaObject(s)),
              {
                external: project.externalComposition,
                native: schemaManager.checkProjectNativeFederationSupport({
                  project,
                  organization,
                }),
              },
            ),
          );

          return raw;
        };

        if (currentVersion.compositeSchemaSDL && currentVersion.hasPersistedSchemaChanges) {
          const changes = await schemaManager.getSchemaChangesForVersion({
            organization: organizationId,
            project: projectId,
            target: targetId,
            version: currentVersion.id,
          });

          return {
            result: {
              schemas: {
                before:
                  previousVersion === null
                    ? null
                    : previousVersion.compositeSchemaSDL ?? (await getBeforeSchemaSDL()),
                current: currentVersion.compositeSchemaSDL,
              },
              changes: changes ?? [],
              versionIds: isCompositeModernProject
                ? {
                    before: previousVersion?.id ?? null,
                    current: currentVersion.id,
                  }
                : null,
            },
          } satisfies SchemaCompareResult;
        }
      }

      // LEGACY LAND
      // If we don't have the stuff in the database we compute it on demand.
      // so we can skip the expensive stuff happening in here...

      const orchestrator = schemaManager.matchOrchestrator(project.type);

      const [{ schemas: schemasBefore, id: previousVersionId }, schemasAfter] = await Promise.all([
        injector.get(SchemaManager).getSchemasOfPreviousVersion({
          organization: organizationId,
          project: projectId,
          target: targetId,
          version: selector.version,
          onlyComposable: organization.featureFlags.compareToPreviousComposableVersion === true,
        }),
        injector.get(SchemaManager).getSchemasOfVersion({
          organization: organizationId,
          project: projectId,
          target: targetId,
          version: selector.version,
        }),
      ]);

      return Promise.all([
        schemasBefore.length
          ? ensureSDL(
              orchestrator.composeAndValidate(
                schemasBefore.map(s => helper.createSchemaObject(s)),
                {
                  external: project.externalComposition,
                  native: schemaManager.checkProjectNativeFederationSupport({
                    project,
                    organization,
                  }),
                },
              ),
            )
          : null,
        ensureSDL(
          orchestrator.composeAndValidate(
            schemasAfter.map(s => helper.createSchemaObject(s)),
            {
              external: project.externalComposition,
              native: schemaManager.checkProjectNativeFederationSupport({
                project,
                organization,
              }),
            },
          ),
          organization.featureFlags.compareToPreviousComposableVersion === true
            ? // Do not show schema changes if the new version is not composable
              // It only applies when the feature flag is enabled.
              // Otherwise, we show the errors as usual.
              'reject-on-graphql-errors'
            : 'ignore-errors',
        ),
      ])
        .then(async ([before, after]) => {
          let changes: SerializableChange[] = [];

          if (before) {
            const previousSchema = buildSchema(
              before,
              error =>
                new GraphQLError(
                  `Failed to build the previous version: ${
                    error instanceof GraphQLError ? error.message : error
                  }`,
                ),
            );
            const currentSchema = buildSchema(
              after,
              error =>
                new GraphQLError(
                  `Failed to build the selected version: ${
                    error instanceof GraphQLError ? error.message : error
                  }`,
                ),
            );
            const diffChanges = await injector.get(Inspector).diff(previousSchema, currentSchema);
            changes = diffChanges.map(change => ({
              ...change,
              isSafeBasedOnUsage: change.criticality.isSafeBasedOnUsage ?? false,
            }));
          }

          changes.push(
            ...detectUrlChanges(schemasBefore, schemasAfter).map(change => ({
              ...change,
              isSafeBasedOnUsage: false,
            })),
          );

          const result: SchemaCompareResult = {
            result: {
              schemas: {
                before: before?.raw ?? null,
                current: after.raw,
              },
              changes,
              versionIds: isCompositeModernProject
                ? {
                    before: previousVersionId ?? null,
                    current: selector.version,
                  }
                : null,
            },
          };

          return result;
        })
        .catch(reason => {
          if (reason instanceof SchemaBuildError) {
            const result: SchemaCompareError = {
              error: reason,
            };
            return Promise.resolve(result);
          }

          return Promise.reject(reason);
        });
    },
    async schemaVersions(_, { selector, after, limit }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project, target] = await Promise.all([
        translator.translateOrganizationId(selector),
        translator.translateProjectId(selector),
        translator.translateTargetId(selector),
      ]);

      return injector.get(SchemaManager).getSchemaVersions({
        organization,
        project,
        target,
        after,
        limit,
      });
    },
    async schemaVersion(_, { selector }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organization, project, target] = await Promise.all([
        translator.translateOrganizationId(selector),
        translator.translateProjectId(selector),
        translator.translateTargetId(selector),
      ]);

      return injector.get(SchemaManager).getSchemaVersion({
        organization,
        project,
        target,
        version: selector.version,
      });
    },
    async latestVersion(_, __, { injector }) {
      const target = await injector.get(TargetManager).getTargetFromToken();

      return injector.get(SchemaManager).getMaybeLatestVersion({
        organization: target.orgId,
        project: target.projectId,
        target: target.id,
      });
    },
    async latestValidVersion(_, __, { injector }) {
      const target = await injector.get(TargetManager).getTargetFromToken();

      return injector.get(SchemaManager).getMaybeLatestValidVersion({
        organization: target.orgId,
        project: target.projectId,
        target: target.id,
      });
    },
    async testExternalSchemaComposition(_, { selector }, { injector }) {
      const translator = injector.get(IdTranslator);
      const [organizationId, projectId] = await Promise.all([
        translator.translateOrganizationId(selector),
        translator.translateProjectId(selector),
      ]);

      const schemaManager = injector.get(SchemaManager);

      const result = await schemaManager.testExternalSchemaComposition({
        organizationId,
        projectId,
      });

      if (result.kind === 'success') {
        return {
          ok: result.project,
        };
      }

      return {
        error: {
          message: result.error,
        },
      };
    },
    async schemaVersionForActionId(_, { actionId }, { injector }) {
      return injector.get(SchemaManager).getSchemaVersionByActionId({
        actionId,
      });
    },
  },
  Target: {
    latestSchemaVersion(target, _, { injector }) {
      return injector.get(SchemaManager).getMaybeLatestVersion({
        target: target.id,
        project: target.projectId,
        organization: target.orgId,
      });
    },
    baseSchema(target, _, { injector }) {
      return injector.get(SchemaManager).getBaseSchema({
        target: target.id,
        project: target.projectId,
        organization: target.orgId,
      });
    },
    hasSchema(target, _, { injector }) {
      return injector.get(SchemaManager).hasSchema({
        target: target.id,
        project: target.projectId,
        organization: target.orgId,
      });
    },
    async schemaCheck(target, args, { injector }) {
      const schemaCheck = await injector.get(SchemaManager).findSchemaCheck({
        targetId: target.id,
        projectId: target.projectId,
        organizationId: target.orgId,
        schemaCheckId: args.id,
      });

      if (schemaCheck == null) {
        return null;
      }

      return toGraphQLSchemaCheck(
        {
          organizationId: target.orgId,
          projectId: target.projectId,
        },
        schemaCheck,
      );
    },
    async schemaChecks(target, args, { injector }) {
      const result = await injector.get(SchemaManager).getPaginatedSchemaChecksForTarget({
        targetId: target.id,
        projectId: target.projectId,
        organizationId: target.orgId,
        first: args.first ?? null,
        cursor: args.after ?? null,
        transformNode: toGraphQLSchemaCheckCurry({
          organizationId: target.orgId,
          projectId: target.projectId,
        }),
      });

      return {
        edges: result.items,
        pageInfo: result.pageInfo,
      };
    },
    schemaVersionsCount(target, { period }, { injector }) {
      return injector.get(SchemaManager).countSchemaVersionsOfTarget({
        organization: target.orgId,
        project: target.projectId,
        target: target.id,
        period: period ? parseDateRangeInput(period) : null,
      });
    },
  },
  SchemaVersion: {
    async log(version, _, { injector }) {
      const log = await injector.get(SchemaManager).getSchemaLog({
        commit: version.commit,
        organization: version.organization,
        project: version.project,
        target: version.target,
      });

      if (log.kind === 'single') {
        return {
          __typename: 'PushedSchemaLog',
          author: log.author,
          commit: log.commit,
          date: log.date as any,
          id: log.id,
          service: null,
        };
      }

      if (log.action === 'DELETE') {
        return {
          __typename: 'DeletedSchemaLog',
          author: 'system',
          commit: 'system',
          date: log.date as any,
          id: log.id,
          deletedService: log.service_name,
        };
      }

      return {
        __typename: 'PushedSchemaLog',
        author: log.author,
        commit: log.commit,
        date: log.date as any,
        id: log.id,
        service: log.service_name,
      };
    },
    schemas(version, _, { injector }) {
      return injector.get(SchemaManager).getMaybeSchemasOfVersion({
        version: version.id,
        organization: version.organization,
        project: version.project,
        target: version.target,
      });
    },
    async errors(version, _, { injector }) {
      const schemaManager = injector.get(SchemaManager);
      const schemaHelper = injector.get(SchemaHelper);
      const [schemas, project, organization] = await Promise.all([
        schemaManager.getMaybeSchemasOfVersion({
          version: version.id,
          organization: version.organization,
          project: version.project,
          target: version.target,
        }),
        injector.get(ProjectManager).getProject({
          organization: version.organization,
          project: version.project,
        }),
        injector.get(OrganizationManager).getOrganization({
          organization: version.organization,
        }),
      ]);

      if (schemas.length === 0) {
        return [];
      }

      const orchestrator = schemaManager.matchOrchestrator(project.type);
      const validation = await orchestrator.composeAndValidate(
        schemas.map(s => schemaHelper.createSchemaObject(s)),
        {
          external: project.externalComposition,
          native: schemaManager.checkProjectNativeFederationSupport({
            project,
            organization,
          }),
        },
      );

      return validation.errors;
    },
    async supergraph(version, _, { injector }) {
      const [project, organization] = await Promise.all([
        injector.get(ProjectManager).getProject({
          organization: version.organization,
          project: version.project,
        }),
        injector.get(OrganizationManager).getOrganization({
          organization: version.organization,
        }),
      ]);

      if (project.type !== ProjectType.FEDERATION) {
        return null;
      }

      if (version.supergraphSDL) {
        return version.supergraphSDL;
      }

      const schemaManager = injector.get(SchemaManager);
      const orchestrator = schemaManager.matchOrchestrator(project.type);
      const helper = injector.get(SchemaHelper);

      const schemas = await schemaManager.getMaybeSchemasOfVersion({
        version: version.id,
        organization: version.organization,
        project: version.project,
        target: version.target,
        includeMetadata: false,
      });

      if (schemas.length === 0) {
        return null;
      }

      return orchestrator
        .composeAndValidate(
          schemas.map(s => helper.createSchemaObject(s)),
          {
            external: project.externalComposition,
            native: schemaManager.checkProjectNativeFederationSupport({
              project,
              organization,
            }),
          },
        )
        .then(r => r.supergraph);
    },
    async sdl(version, _, { injector }) {
      const [project, organization] = await Promise.all([
        injector.get(ProjectManager).getProject({
          organization: version.organization,
          project: version.project,
        }),
        injector.get(OrganizationManager).getOrganization({
          organization: version.organization,
        }),
      ]);

      const schemaManager = injector.get(SchemaManager);
      const orchestrator = schemaManager.matchOrchestrator(project.type);
      const helper = injector.get(SchemaHelper);

      const schemas = await schemaManager.getMaybeSchemasOfVersion({
        version: version.id,
        organization: version.organization,
        project: version.project,
        target: version.target,
        includeMetadata: false,
      });

      if (schemas.length === 0) {
        return null;
      }

      return (
        await ensureSDL(
          orchestrator.composeAndValidate(
            schemas.map(s => helper.createSchemaObject(s)),
            {
              external: project.externalComposition,
              native: schemaManager.checkProjectNativeFederationSupport({
                project,
                organization,
              }),
            },
          ),
        )
      ).raw;
    },
    async baseSchema(version) {
      return version.baseSchema || null;
    },
    async explorer(version, { usage }, { injector }) {
      const [project, organization] = await Promise.all([
        injector.get(ProjectManager).getProject({
          organization: version.organization,
          project: version.project,
        }),
        injector.get(OrganizationManager).getOrganization({
          organization: version.organization,
        }),
      ]);

      const schemaManager = injector.get(SchemaManager);
      const orchestrator = schemaManager.matchOrchestrator(project.type);
      const helper = injector.get(SchemaHelper);

      let supergraph: SuperGraphInformation | null = null;

      if (project.type === ProjectType.FEDERATION) {
        let supergraphDocument: DocumentNode | null = null;
        if (version.supergraphSDL) {
          supergraphDocument = parse(version.supergraphSDL);
        } else {
          // Legacy Fallback
          const schemas = await injector.get(SchemaManager).getSchemasOfVersion({
            organization: version.organization,
            project: version.project,
            target: version.target,
            version: version.id,
          });

          const result = await orchestrator.composeAndValidate(
            schemas.map(s => helper.createSchemaObject(s)),
            {
              external: project.externalComposition,
              native: schemaManager.checkProjectNativeFederationSupport({
                project,
                organization,
              }),
            },
          );

          if (result.supergraph) {
            supergraphDocument = parse(result.supergraph);
          }
        }

        if (supergraphDocument) {
          supergraph = extractSuperGraphInformation(supergraphDocument);
        }
      }

      let schemaAST: DocumentNode;
      if (version.compositeSchemaSDL) {
        schemaAST = parse(version.compositeSchemaSDL);
      } else {
        // Legacy Fallback
        const schemas = await injector.get(SchemaManager).getSchemasOfVersion({
          organization: version.organization,
          project: version.project,
          target: version.target,
          version: version.id,
        });

        const schema = await ensureSDL(
          orchestrator.composeAndValidate(
            schemas.map(s => helper.createSchemaObject(s)),
            {
              external: project.externalComposition,
              native: schemaManager.checkProjectNativeFederationSupport({
                project,
                organization,
              }),
            },
          ),
        );

        schemaAST = schema.document;
      }

      return {
        schema: buildASTSchema(schemaAST, {
          assumeValidSDL: true,
          assumeValid: true,
        }),
        usage: {
          period: usage?.period ? parseDateRangeInput(usage.period) : createPeriod('30d'),
          organization: version.organization,
          project: version.project,
          target: version.target,
        },
        supergraph,
      };
    },
    date: version => version.createdAt,
  },
  SchemaCompareError: {
    __isTypeOf(source: unknown) {
      return typeof source === 'object' && source != null && 'error' in source;
    },
    message: source => source.error.message,
    details: source =>
      source.error.errors.map(err => ({
        message: err.message,
        type: err.source,
      })),
  },
  SchemaCompareResult: {
    __isTypeOf(source: unknown) {
      return typeof source === 'object' && source != null && 'result' in source;
    },
    initial(source) {
      return source.result.schemas.before === null;
    },
    async changes(source) {
      return source.result.changes.map(change =>
        toGraphQLSchemaChange(schemaChangeFromMeta(change)),
      );
    },
    diff(source) {
      const { before, current } = source.result.schemas;

      return {
        before: before ?? '',
        after: current,
      };
    },
    async service(source, _, { injector }) {
      const versionIds = source.result.versionIds;

      if (!versionIds) {
        return null;
      }

      const serviceSchema = await injector.get(SchemaManager).getMatchingServiceSchemaOfVersions({
        before: versionIds.before,
        after: versionIds.current,
      });

      if (!serviceSchema) {
        return null;
      }

      return {
        name: serviceSchema.serviceName,
        before: serviceSchema.before,
        after: serviceSchema.after,
      };
    },
  },
  SingleSchema: {
    __isTypeOf(obj) {
      return obj.kind === 'single';
    },
    source(schema) {
      return schema.sdl;
    },
  },
  CompositeSchema: {
    __isTypeOf(obj) {
      return obj.kind === 'composite' && obj.action === 'PUSH';
    },
    service(schema) {
      return schema.service_name;
    },
    source(schema) {
      return schema.sdl;
    },
    url(schema) {
      return schema.service_url;
    },
  },
  SchemaConnection: createConnection(),
  SchemaVersionConnection: {
    pageInfo(info) {
      return {
        hasNextPage: info.hasMore,
        hasPreviousPage: false,
        endCursor: '',
        startCursor: '',
      };
    },
  },
  SchemaChangeConnection: createConnection(),
  SchemaErrorConnection: createConnection(),
  SchemaWarningConnection: createConnection(),
  SchemaCheckSuccess: {
    __isTypeOf(obj) {
      return obj.valid;
    },
  },
  SchemaCheckError: {
    __isTypeOf(obj) {
      return !obj.valid;
    },
  },
  Project: {
    externalSchemaComposition(project) {
      if (project.externalComposition.enabled && project.externalComposition.endpoint) {
        return {
          endpoint: project.externalComposition.endpoint,
        };
      }

      return null;
    },
    registryModel(project) {
      return project.legacyRegistryModel ? 'LEGACY' : 'MODERN';
    },
    schemaVersionsCount(project, { period }, { injector }) {
      return injector.get(SchemaManager).countSchemaVersionsOfProject({
        organization: project.orgId,
        project: project.id,
        period: period ? parseDateRangeInput(period) : null,
      });
    },
  },
  SchemaExplorer: {
    async type(source, { name }, { injector }) {
      const entity = source.schema.getType(name);
      const operationsManager = injector.get(OperationsManager);

      if (!entity) {
        return null;
      }

      const { supergraph } = source;
      const usage = injector
        .get(OperationsManager)
        .countCoordinatesOfType({
          typename: entity.name,
          organization: source.usage.organization,
          project: source.usage.project,
          target: source.usage.target,
          period: source.usage.period,
        })
        .then(usage =>
          withUsedByClients(usage, {
            selector: source.usage,
            period: source.usage.period,
            operationsManager,
            typename: entity.name,
          }),
        );

      if (isObjectType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                getFieldOwnedByServices: (fieldName: string) =>
                  supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                  null,
              }
            : null,
        } satisfies GraphQLObjectTypeMapper;
      }
      if (isInterfaceType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                getFieldOwnedByServices: (fieldName: string) =>
                  supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                  null,
              }
            : null,
        } satisfies GraphQLInterfaceTypeMapper;
      }
      if (isEnumType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                getEnumValueOwnedByServices: (fieldName: string) =>
                  supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                  null,
              }
            : null,
        } satisfies GraphQLEnumTypeMapper;
      }
      if (isUnionType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                getUnionMemberOwnedByServices: (memberName: string) =>
                  supergraph.schemaCoordinateServicesMappings.get(memberName) ?? null,
              }
            : null,
        } satisfies GraphQLUnionTypeMapper;
      }
      if (isInputObjectType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                getInputFieldOwnedByServices: (inputFieldName: string) =>
                  supergraph.schemaCoordinateServicesMappings.get(
                    `${entity.name}.${inputFieldName}`,
                  ) ?? null,
              }
            : null,
        } satisfies GraphQLInputObjectTypeMapper;
      }
      if (isScalarType(entity)) {
        return {
          entity,
          usage,
          supergraph: supergraph
            ? {
                ownedByServiceNames:
                  supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
              }
            : null,
        } satisfies GraphQLScalarTypeMapper;
      }

      throw new Error('Illegal state: unknown type kind');
    },
    async types({ schema, usage, supergraph }, _, { injector }) {
      const types: Array<
        | GraphQLObjectTypeMapper
        | GraphQLInterfaceTypeMapper
        | GraphQLUnionTypeMapper
        | GraphQLEnumTypeMapper
        | GraphQLInputObjectTypeMapper
        | GraphQLScalarTypeMapper
      > = [];
      const typeMap = schema.getTypeMap();
      const operationsManager = injector.get(OperationsManager);

      async function getStats(typename: string) {
        const stats = await operationsManager.countCoordinatesOfTarget({
          target: usage.target,
          organization: usage.organization,
          project: usage.project,
          period: usage.period,
        });

        return withUsedByClients(stats, {
          selector: usage,
          period: usage.period,
          operationsManager,
          typename,
        });
      }

      for (const typename in typeMap) {
        if (typename.startsWith('__')) {
          continue;
        }

        const entity = typeMap[typename];

        if (isObjectType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(typename) ?? null,
                  getFieldOwnedByServices: (fieldName: string) =>
                    supergraph.schemaCoordinateServicesMappings.get(`${typename}.${fieldName}`) ??
                    null,
                }
              : null,
          });
        } else if (isInterfaceType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(typename) ?? null,
                  getFieldOwnedByServices: (fieldName: string) =>
                    supergraph.schemaCoordinateServicesMappings.get(`${typename}.${fieldName}`) ??
                    null,
                }
              : null,
          });
        } else if (isEnumType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(typename) ?? null,
                  getEnumValueOwnedByServices: (fieldName: string) =>
                    supergraph.schemaCoordinateServicesMappings.get(`${typename}.${fieldName}`) ??
                    null,
                }
              : null,
          });
        } else if (isUnionType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(typename) ?? null,
                  getUnionMemberOwnedByServices: (memberName: string) =>
                    supergraph.schemaCoordinateServicesMappings.get(memberName) ?? null,
                }
              : null,
          });
        } else if (isInputObjectType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(typename) ?? null,
                  getInputFieldOwnedByServices: (inputFieldName: string) =>
                    supergraph.schemaCoordinateServicesMappings.get(
                      `${typename}.${inputFieldName}`,
                    ) ?? null,
                }
              : null,
          });
        } else if (isScalarType(entity)) {
          types.push({
            entity,
            get usage() {
              return getStats(entity.name);
            },
            supergraph: supergraph
              ? {
                  ownedByServiceNames:
                    supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
                }
              : null,
          });
        }
      }

      types.sort((a, b) => a.entity.name.localeCompare(b.entity.name));

      return types;
    },
    async query({ schema, usage, supergraph }, _, { injector }) {
      const operationsManager = injector.get(OperationsManager);
      const entity = schema.getQueryType();

      if (!entity) {
        return null;
      }

      return {
        entity,
        get usage() {
          return operationsManager
            .countCoordinatesOfType({
              typename: entity.name,
              organization: usage.organization,
              project: usage.project,
              target: usage.target,
              period: usage.period,
            })
            .then(stats =>
              withUsedByClients(stats, {
                selector: usage,
                period: usage.period,
                operationsManager,
                typename: entity.name,
              }),
            );
        },
        supergraph: supergraph
          ? {
              ownedByServiceNames:
                supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
              getFieldOwnedByServices: (fieldName: string) =>
                supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                null,
            }
          : null,
      };
    },
    async mutation({ schema, usage, supergraph }, _, { injector }) {
      const operationsManager = injector.get(OperationsManager);
      const entity = schema.getMutationType();

      if (!entity) {
        return null;
      }

      return {
        entity,
        get usage() {
          return operationsManager
            .countCoordinatesOfType({
              typename: entity.name,
              organization: usage.organization,
              project: usage.project,
              target: usage.target,
              period: usage.period,
            })
            .then(stats =>
              withUsedByClients(stats, {
                selector: usage,
                period: usage.period,
                operationsManager,
                typename: entity.name,
              }),
            );
        },
        supergraph: supergraph
          ? {
              ownedByServiceNames:
                supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
              getFieldOwnedByServices: (fieldName: string) =>
                supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                null,
            }
          : null,
      };
    },

    async subscription({ schema, usage, supergraph }, _, { injector }) {
      const operationsManager = injector.get(OperationsManager);
      const entity = schema.getSubscriptionType();

      if (!entity) {
        return null;
      }

      return {
        entity,
        get usage() {
          return operationsManager
            .countCoordinatesOfType({
              typename: entity.name,
              organization: usage.organization,
              project: usage.project,
              target: usage.target,
              period: usage.period,
            })
            .then(stats =>
              withUsedByClients(stats, {
                selector: usage,
                period: usage.period,
                operationsManager,
                typename: entity.name,
              }),
            );
        },
        supergraph: supergraph
          ? {
              ownedByServiceNames:
                supergraph.schemaCoordinateServicesMappings.get(entity.name) ?? null,
              getFieldOwnedByServices: (fieldName: string) =>
                supergraph.schemaCoordinateServicesMappings.get(`${entity.name}.${fieldName}`) ??
                null,
            }
          : null,
      };
    },
  },
  GraphQLObjectType: {
    __isTypeOf: __isTypeOf(isObjectType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    fields: t =>
      Object.values(t.entity.getFields()).map(f => ({
        entity: f,
        parent: {
          coordinate: t.entity.name,
        },
        usage: t.usage,
        supergraph: t.supergraph
          ? { ownedByServiceNames: t.supergraph.getFieldOwnedByServices(f.name) }
          : null,
      })),
    interfaces: t => t.entity.getInterfaces().map(i => i.name),
    usage,
    supergraphMetadata: t =>
      t.supergraph
        ? {
            ownedByServiceNames: t.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLInterfaceType: {
    __isTypeOf: __isTypeOf(isInterfaceType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    fields: t =>
      Object.values(t.entity.getFields()).map(f => ({
        entity: f,
        parent: {
          coordinate: t.entity.name,
        },
        usage: t.usage,
        supergraph: t.supergraph
          ? { ownedByServiceNames: t.supergraph.getFieldOwnedByServices(f.name) }
          : null,
      })),
    interfaces: t => t.entity.getInterfaces().map(i => i.name),
    usage,
    supergraphMetadata: t =>
      t.supergraph
        ? {
            ownedByServiceNames: t.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLUnionType: {
    __isTypeOf: __isTypeOf(isUnionType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    members: t =>
      t.entity.getTypes().map(i => {
        return {
          entity: i,
          usage: t.usage,
          parent: {
            coordinate: t.entity.name,
          },
          supergraph: t.supergraph
            ? {
                ownedByServiceNames: t.supergraph.getUnionMemberOwnedByServices(i.name),
              }
            : null,
        };
      }),
    usage,
    supergraphMetadata: t =>
      t.supergraph
        ? {
            ownedByServiceNames: t.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLEnumType: {
    __isTypeOf: __isTypeOf(isEnumType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    values: t =>
      t.entity.getValues().map(v => ({
        entity: v,
        parent: {
          coordinate: t.entity.name,
        },
        usage: t.usage,
        supergraph: t.supergraph
          ? { ownedByServiceNames: t.supergraph.getEnumValueOwnedByServices(v.name) }
          : null,
      })),
    usage,
    supergraphMetadata: t =>
      t.supergraph
        ? {
            ownedByServiceNames: t.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLInputObjectType: {
    __isTypeOf: __isTypeOf(isInputObjectType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    fields: t =>
      Object.values(t.entity.getFields()).map(f => ({
        entity: f,
        parent: {
          coordinate: t.entity.name,
        },
        usage: t.usage,
        supergraph: t.supergraph
          ? {
              ownedByServiceNames: t.supergraph.getInputFieldOwnedByServices(f.name),
            }
          : null,
      })),
    usage,
    supergraphMetadata: t =>
      t.supergraph
        ? {
            ownedByServiceNames: t.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLScalarType: {
    __isTypeOf: __isTypeOf(isScalarType),
    name: t => t.entity.name,
    description: t => t.entity.description ?? null,
    usage,
    supergraphMetadata: t =>
      t.supergraph ? { ownedByServiceNames: t.supergraph.ownedByServiceNames } : null,
  },
  GraphQLEnumValue: {
    name: v => v.entity.name,
    description: v => v.entity.description ?? null,
    isDeprecated: v => typeof v.entity.deprecationReason === 'string',
    deprecationReason: v => v.entity.deprecationReason ?? null,
    usage,
    supergraphMetadata: v =>
      v.supergraph ? { ownedByServiceNames: v.supergraph.ownedByServiceNames } : null,
  },
  GraphQLUnionTypeMember: {
    name: m => m.entity.name,
    usage,
    supergraphMetadata: m =>
      m.supergraph ? { ownedByServiceNames: m.supergraph.ownedByServiceNames } : null,
  },
  GraphQLField: {
    name: f => f.entity.name,
    description: f => f.entity.description ?? null,
    isDeprecated: f => typeof f.entity.deprecationReason === 'string',
    deprecationReason: f => f.entity.deprecationReason ?? null,
    type: f => f.entity.type.toString(),
    args: f =>
      f.entity.args.map(a => ({
        entity: a,
        parent: {
          coordinate: `${f.parent.coordinate}.${f.entity.name}`,
        },
        usage: f.usage,
      })),
    usage,
    supergraphMetadata: f =>
      f.supergraph
        ? {
            ownedByServiceNames: f.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLInputField: {
    name: f => f.entity.name,
    description: f => f.entity.description ?? null,
    type: f => f.entity.type.toString(),
    defaultValue: f => stringifyDefaultValue(f.entity.defaultValue),
    isDeprecated: f => typeof f.entity.deprecationReason === 'string',
    deprecationReason: f => f.entity.deprecationReason ?? null,
    usage,
    supergraphMetadata: f =>
      f.supergraph
        ? {
            ownedByServiceNames: f.supergraph.ownedByServiceNames,
          }
        : null,
  },
  GraphQLArgument: {
    name: a => a.entity.name,
    description: a => a.entity.description ?? null,
    type: a => a.entity.type.toString(),
    defaultValue: a => stringifyDefaultValue(a.entity.defaultValue),
    deprecationReason: a => a.entity.deprecationReason ?? null,
    isDeprecated: a => typeof a.entity.deprecationReason === 'string',
    usage,
  },
  SuccessfulSchemaCheck: {
    schemaVersion(schemaCheck, _, { injector }) {
      if (schemaCheck.schemaVersionId === null) {
        return null;
      }
      return injector.get(SchemaManager).getSchemaVersion({
        organization: schemaCheck.selector.organizationId,
        project: schemaCheck.selector.projectId,
        target: schemaCheck.targetId,
        version: schemaCheck.schemaVersionId,
      });
    },
    safeSchemaChanges(schemaCheck) {
      if (!schemaCheck.safeSchemaChanges) {
        return null;
      }

      return schemaCheck.safeSchemaChanges.map(toGraphQLSchemaChange);
    },
    breakingSchemaChanges(schemaCheck) {
      if (!schemaCheck.breakingSchemaChanges) {
        return null;
      }

      return schemaCheck.breakingSchemaChanges.map(toGraphQLSchemaChange);
    },
    webUrl(schemaCheck, _, { injector }) {
      return injector.get(SchemaManager).getSchemaCheckWebUrl({
        schemaCheckId: schemaCheck.id,
        targetId: schemaCheck.targetId,
      });
    },
    isApproved(schemaCheck) {
      return schemaCheck.isManuallyApproved;
    },
    approvedBy(schemaCheck, _, { injector }) {
      return injector.get(SchemaManager).getApprovedByUser({
        organizationId: schemaCheck.selector.organizationId,
        userId: schemaCheck.manualApprovalUserId,
      });
    },
  },
  FailedSchemaCheck: {
    schemaVersion(schemaCheck, _, { injector }) {
      if (schemaCheck.schemaVersionId === null) {
        return null;
      }
      return injector.get(SchemaManager).getSchemaVersion({
        organization: schemaCheck.selector.organizationId,
        project: schemaCheck.selector.projectId,
        target: schemaCheck.targetId,
        version: schemaCheck.schemaVersionId,
      });
    },
    safeSchemaChanges(schemaCheck) {
      if (!schemaCheck.safeSchemaChanges) {
        return null;
      }

      return schemaCheck.safeSchemaChanges.map(toGraphQLSchemaChange);
    },
    breakingSchemaChanges(schemaCheck) {
      if (!schemaCheck.breakingSchemaChanges) {
        return null;
      }

      return schemaCheck.breakingSchemaChanges.map(toGraphQLSchemaChange);
    },
    compositionErrors(schemaCheck) {
      return schemaCheck.schemaCompositionErrors;
    },
    webUrl(schemaCheck, _, { injector }) {
      return injector.get(SchemaManager).getSchemaCheckWebUrl({
        schemaCheckId: schemaCheck.id,
        targetId: schemaCheck.targetId,
      });
    },
    async canBeApproved(schemaCheck, _, { injector }) {
      return injector.get(SchemaManager).getFailedSchemaCheckCanBeApproved({
        schemaCompositionErrors: schemaCheck.schemaCompositionErrors,
      });
    },
    async canBeApprovedByViewer(schemaCheck, _, { injector }) {
      return injector.get(SchemaManager).getFailedSchemaCheckCanBeApprovedByViewer({
        organizationId: schemaCheck.selector.organizationId,
        schemaCompositionErrors: schemaCheck.schemaCompositionErrors,
      });
    },
  },
  SchemaPolicyWarningConnection: createDummyConnection(warning => ({
    ...warning,
    start: {
      column: warning.column,
      line: warning.line,
    },
    end:
      warning.endColumn && warning.endLine
        ? {
            column: warning.endColumn,
            line: warning.endLine,
          }
        : null,
  })),
};

function stringifyDefaultValue(value: unknown): string | null {
  if (typeof value !== 'undefined') {
    return stringify(value);
  }
  return null;
}

function withUsedByClients<
  T extends {
    isUsed: boolean;
  },
>(
  input: Record<string, T>,
  deps: {
    selector: TargetSelector;
    operationsManager: OperationsManager;
    period: DateRange;
    typename: string;
  },
): Record<string, T & { usedByClients: PromiseOrValue<Array<string> | null> }> {
  return Object.fromEntries(
    Object.entries(input).map(([schemaCoordinate, record]) => [
      schemaCoordinate,
      {
        ...record,
        get usedByClients() {
          if (record.isUsed === false) {
            return null;
          }

          // It's using DataLoader under the hood so it's safe to call it multiple times for different coordinates
          return deps.operationsManager.getClientNamesPerCoordinateOfType({
            ...deps.selector,
            period: deps.period,
            typename: deps.typename,
            schemaCoordinate,
          });
        },
      },
    ]),
  );
}
