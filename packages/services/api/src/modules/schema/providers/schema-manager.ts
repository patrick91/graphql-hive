import { parse } from 'graphql';
import { Inject, Injectable, Scope } from 'graphql-modules';
import lodash from 'lodash';
import { z } from 'zod';
import { Change } from '@graphql-inspector/core';
import type { SchemaCheck, SchemaCompositionError } from '@hive/storage';
import { RegistryModel } from '../../../__generated__/types';
import {
  DateRange,
  Orchestrator,
  Organization,
  Project,
  ProjectType,
} from '../../../shared/entities';
import { HiveError } from '../../../shared/errors';
import { atomic, stringifySelector } from '../../../shared/helpers';
import { SchemaVersion } from '../../../shared/mappers';
import { AuthManager } from '../../auth/providers/auth-manager';
import { ProjectAccessScope } from '../../auth/providers/project-access';
import { TargetAccessScope } from '../../auth/providers/target-access';
import { GitHubIntegrationManager } from '../../integrations/providers/github-integration-manager';
import { OrganizationManager } from '../../organization/providers/organization-manager';
import { ProjectManager } from '../../project/providers/project-manager';
import { CryptoProvider } from '../../shared/providers/crypto';
import { Logger } from '../../shared/providers/logger';
import {
  OrganizationSelector,
  ProjectSelector,
  Storage,
  TargetSelector,
} from '../../shared/providers/storage';
import { TargetManager } from '../../target/providers/target-manager';
import { schemaChangeFromMeta } from '../schema-change-from-meta';
import { SCHEMA_MODULE_CONFIG, type SchemaModuleConfig } from './config';
import { FederationOrchestrator } from './orchestrators/federation';
import { SingleOrchestrator } from './orchestrators/single';
import { StitchingOrchestrator } from './orchestrators/stitching';

const ENABLE_EXTERNAL_COMPOSITION_SCHEMA = z.object({
  endpoint: z.string().url().nonempty(),
  secret: z.string().nonempty(),
});

type Paginated<T> = T & {
  after?: string | null;
  limit: number;
};

const externalSchemaCompositionTestSdl = /* GraphQL */ `
  type Query {
    test: String
  }
`;
const externalSchemaCompositionTestDocument = parse(externalSchemaCompositionTestSdl);

/**
 * Responsible for auth checks.
 * Talks to Storage.
 */
@Injectable({
  scope: Scope.Operation,
  global: true,
})
export class SchemaManager {
  private logger: Logger;

  constructor(
    logger: Logger,
    private authManager: AuthManager,
    private storage: Storage,
    private projectManager: ProjectManager,
    private singleOrchestrator: SingleOrchestrator,
    private stitchingOrchestrator: StitchingOrchestrator,
    private federationOrchestrator: FederationOrchestrator,
    private crypto: CryptoProvider,
    private githubIntegrationManager: GitHubIntegrationManager,
    private targetManager: TargetManager,
    private organizationManager: OrganizationManager,
    @Inject(SCHEMA_MODULE_CONFIG) private schemaModuleConfig: SchemaModuleConfig,
  ) {
    this.logger = logger.child({ source: 'SchemaManager' });
  }

  async hasSchema(selector: TargetSelector) {
    this.logger.debug('Checking if schema is available (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.hasSchema(selector);
  }

  @atomic(stringifySelector)
  async getSchemasOfVersion(
    selector: {
      version: string;
      includeMetadata?: boolean;
    } & TargetSelector,
  ) {
    this.logger.debug('Fetching non-empty list of schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    const schemas = await this.storage.getSchemasOfVersion(selector);

    if (schemas.length === 0) {
      throw new HiveError('No schemas found for this version.');
    }

    return schemas;
  }

  @atomic(stringifySelector)
  async getMaybeSchemasOfVersion(
    selector: {
      version: string;
      includeMetadata?: boolean;
    } & TargetSelector,
  ) {
    this.logger.debug('Fetching schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemasOfVersion(selector);
  }

  async getSchemasOfPreviousVersion(
    selector: {
      version: string;
      onlyComposable: boolean;
    } & TargetSelector,
  ) {
    this.logger.debug(
      'Fetching schemas from the previous version (onlyComposable=%s, selector=%o)',
      selector.onlyComposable,
      selector,
    );
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemasOfPreviousVersion(selector);
  }

  async getLatestSchemas(
    selector: TargetSelector & {
      onlyComposable?: boolean;
    },
  ) {
    this.logger.debug('Fetching latest schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getLatestSchemas(selector);
  }

  async getMatchingServiceSchemaOfVersions(versions: { before: string | null; after: string }) {
    this.logger.debug('Fetching service schema of versions (selector=%o)', versions);
    return this.storage.getMatchingServiceSchemaOfVersions(versions);
  }

  async getMaybeLatestValidVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest valid version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const version = await this.storage.getMaybeLatestValidVersion(selector);

    if (!version) {
      return null;
    }

    return {
      ...version,
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getLatestValidVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest valid version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return {
      ...(await this.storage.getLatestValidVersion(selector)),
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getLatestVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return {
      ...(await this.storage.getLatestVersion(selector)),
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getMaybeLatestVersion(selector: TargetSelector) {
    this.logger.debug('Fetching maybe latest version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const latest = await this.storage.getMaybeLatestVersion(selector);

    if (!latest) {
      return null;
    }

    return {
      ...latest,
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getSchemaVersion(selector: TargetSelector & { version: string }) {
    this.logger.debug('Fetching single schema version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    const result = await this.storage.getVersion(selector);

    return {
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
      ...result,
    };
  }

  async getSchemaChangesForVersion(selector: TargetSelector & { version: string }) {
    this.logger.debug('Fetching single schema version changes (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    return await this.storage.getSchemaChangesForVersion({ versionId: selector.version });
  }

  async getSchemaVersions(selector: Paginated<TargetSelector>) {
    this.logger.debug('Fetching published schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    const result = await this.storage.getVersions(selector);

    return {
      nodes: result.versions.map(r => ({
        ...r,
        project: selector.project,
        target: selector.target,
        organization: selector.organization,
      })),
      hasMore: result.hasMore,
    };
  }

  async updateSchemaVersionStatus(
    input: TargetSelector & { version: string; valid: boolean },
  ): Promise<SchemaVersion> {
    this.logger.debug('Updating schema version status (input=%o)', input);
    await this.authManager.ensureTargetAccess({
      ...input,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    const project = await this.storage.getProject({
      organization: input.organization,
      project: input.project,
    });

    if (project.legacyRegistryModel) {
      return {
        ...(await this.storage.updateVersionStatus(input)),
        organization: input.organization,
        project: input.project,
        target: input.target,
      };
    }

    throw new HiveError(`Updating the status is supported only by legacy projects`);
  }

  async getSchemaLog(selector: { commit: string } & TargetSelector) {
    this.logger.debug('Fetching schema log (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemaLog({
      commit: selector.commit,
      target: selector.target,
    });
  }

  async createVersion(
    input: ({
      commit: string;
      schema: string;
      author: string;
      valid: boolean;
      service?: string | null;
      logIds: string[];
      url?: string | null;
      base_schema: string | null;
      metadata: string | null;
      projectType: ProjectType;
      actionFn(): Promise<void>;
      changes: Array<Change>;
      previousSchemaVersion: string | null;
    } & TargetSelector) &
      (
        | {
            compositeSchemaSDL: null;
            supergraphSDL: null;
            schemaCompositionErrors: Array<SchemaCompositionError>;
          }
        | {
            compositeSchemaSDL: string;
            supergraphSDL: string | null;
            schemaCompositionErrors: null;
          }
      ),
  ) {
    this.logger.info(
      'Creating a new version (input=%o)',
      lodash.omit(input, ['schema', 'actionFn']),
    );

    await this.authManager.ensureTargetAccess({
      project: input.project,
      organization: input.organization,
      target: input.target,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    return this.storage.createVersion({
      ...input,
      logIds: input.logIds,
    });
  }

  async testExternalSchemaComposition(selector: { projectId: string; organizationId: string }) {
    await this.authManager.ensureProjectAccess({
      project: selector.projectId,
      organization: selector.organizationId,
      scope: ProjectAccessScope.SETTINGS,
    });

    const [project, organization] = await Promise.all([
      this.storage.getProject({
        organization: selector.organizationId,
        project: selector.projectId,
      }),
      this.storage.getOrganization({
        organization: selector.organizationId,
      }),
    ]);

    if (project.type !== ProjectType.FEDERATION) {
      throw new HiveError(
        'Project is not of Federation type. External composition is not available.',
      );
    }

    if (!project.externalComposition.enabled) {
      throw new HiveError('External composition is not enabled.');
    }

    const orchestrator = this.matchOrchestrator(project.type);

    try {
      const { errors } = await orchestrator.composeAndValidate(
        [
          {
            document: externalSchemaCompositionTestDocument,
            raw: externalSchemaCompositionTestSdl,
            source: 'test',
            url: null,
          },
        ],
        {
          external: project.externalComposition,
          native: this.checkProjectNativeFederationSupport({
            project,
            organization,
          }),
        },
      );

      if (errors.length > 0) {
        return {
          kind: 'error',
          error: errors[0].message,
        } as const;
      }

      return {
        kind: 'success',
        project,
      } as const;
    } catch (error) {
      return {
        kind: 'error',
        error: error instanceof HiveError ? error.message : 'Unknown error',
      } as const;
    }
  }

  matchOrchestrator(projectType: ProjectType): Orchestrator | never {
    switch (projectType) {
      case ProjectType.SINGLE: {
        return this.singleOrchestrator;
      }
      case ProjectType.STITCHING: {
        return this.stitchingOrchestrator;
      }
      case ProjectType.FEDERATION: {
        return this.federationOrchestrator;
      }
      default: {
        throw new HiveError(`Couldn't find an orchestrator for project type "${projectType}"`);
      }
    }
  }

  async getBaseSchema(selector: TargetSelector) {
    this.logger.debug('Fetching base schema (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return await this.storage.getBaseSchema(selector);
  }
  async updateBaseSchema(selector: TargetSelector, newBaseSchema: string | null) {
    this.logger.debug('Updating base schema (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    await this.storage.updateBaseSchema(selector, newBaseSchema);
  }

  countSchemaVersionsOfProject(
    selector: ProjectSelector & {
      period: DateRange | null;
    },
  ): Promise<number> {
    this.logger.debug('Fetching schema versions count of project (selector=%o)', selector);
    return this.storage.countSchemaVersionsOfProject(selector);
  }

  countSchemaVersionsOfTarget(
    selector: TargetSelector & {
      period: DateRange | null;
    },
  ): Promise<number> {
    this.logger.debug('Fetching schema versions count of target (selector=%o)', selector);
    return this.storage.countSchemaVersionsOfTarget(selector);
  }

  completeGetStartedCheck(
    selector: OrganizationSelector & {
      step: 'publishingSchema' | 'checkingSchema';
    },
  ): Promise<void> {
    return this.storage.completeGetStartedStep(selector);
  }

  async disableExternalSchemaComposition(input: ProjectSelector) {
    this.logger.debug('Disabling external composition (input=%o)', input);
    await this.authManager.ensureProjectAccess({
      ...input,
      scope: ProjectAccessScope.SETTINGS,
    });

    await this.storage.disableExternalSchemaComposition(input);

    return {
      ok: await this.projectManager.getProject({
        organization: input.organization,
        project: input.project,
      }),
    };
  }

  async enableExternalSchemaComposition(
    input: ProjectSelector & {
      endpoint: string;
      secret: string;
    },
  ) {
    this.logger.debug('Enabling external composition (input=%o)', lodash.omit(input, ['secret']));
    await this.authManager.ensureProjectAccess({
      ...input,
      scope: ProjectAccessScope.SETTINGS,
    });

    const parseResult = ENABLE_EXTERNAL_COMPOSITION_SCHEMA.safeParse({
      endpoint: input.endpoint,
      secret: input.secret,
    });

    if (!parseResult.success) {
      return {
        error: {
          message: parseResult.error.message,
          inputErrors: {
            endpoint: parseResult.error.formErrors.fieldErrors.endpoint?.[0],
            secret: parseResult.error.formErrors.fieldErrors.secret?.[0],
          },
        },
      };
    }

    const encryptedSecret = this.crypto.encrypt(input.secret);

    await this.storage.enableExternalSchemaComposition({
      project: input.project,
      organization: input.organization,
      endpoint: input.endpoint.trim(),
      encryptedSecret,
    });

    return {
      ok: await this.projectManager.getProject({
        organization: input.organization,
        project: input.project,
      }),
    };
  }

  async updateRegistryModel(
    input: ProjectSelector & {
      model: RegistryModel;
    },
  ) {
    this.logger.debug('Updating registry model (input=%o)', input);
    await this.authManager.ensureProjectAccess({
      ...input,
      scope: ProjectAccessScope.SETTINGS,
    });

    return {
      ok: this.storage.updateProjectRegistryModel(input),
    };
  }

  async getPaginatedSchemaChecksForTarget<
    TransformedSchemaCheck extends InflatedSchemaCheck,
  >(args: {
    organizationId: string;
    projectId: string;
    targetId: string;
    first: number | null;
    cursor: string | null;
    transformNode: (check: InflatedSchemaCheck) => TransformedSchemaCheck;
  }) {
    await this.authManager.ensureTargetAccess({
      organization: args.organizationId,
      project: args.projectId,
      target: args.targetId,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const paginatedResult = await this.storage.getPaginatedSchemaChecksForTarget({
      targetId: args.targetId,
      first: args.first,
      cursor: args.cursor,
      transformNode: node => args.transformNode(inflateSchemaCheck(node)),
    });

    return paginatedResult;
  }

  async findSchemaCheck(args: {
    targetId: string;
    projectId: string;
    organizationId: string;
    schemaCheckId: string;
  }) {
    this.logger.debug('Find schema check (args=%o)', args);
    await this.authManager.ensureTargetAccess({
      target: args.targetId,
      project: args.projectId,
      organization: args.organizationId,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const schemaCheck = await this.storage.findSchemaCheck({
      targetId: args.targetId,
      schemaCheckId: args.schemaCheckId,
    });

    if (schemaCheck == null) {
      this.logger.debug('Schema check not found (args=%o)', args);
      return null;
    }

    return inflateSchemaCheck(schemaCheck);
  }

  async getSchemaCheckWebUrl(args: {
    schemaCheckId: string;
    targetId: string;
  }): Promise<null | string> {
    if (this.schemaModuleConfig.schemaCheckLink == null) {
      return null;
    }

    const breadcrumb = await this.storage.getTargetBreadcrumbForTargetId({
      targetId: args.targetId,
    });
    if (!breadcrumb) {
      return null;
    }

    return this.schemaModuleConfig.schemaCheckLink({
      organization: {
        cleanId: breadcrumb.organization,
      },
      project: {
        cleanId: breadcrumb.project,
      },
      target: {
        cleanId: breadcrumb.target,
      },
      schemaCheckId: args.schemaCheckId,
    });
  }

  /**
   * Whether a failed schema check can be approved manually.
   */
  getFailedSchemaCheckCanBeApproved(args: { schemaCompositionErrors: Array<unknown> | null }) {
    return !args.schemaCompositionErrors;
  }

  async getFailedSchemaCheckCanBeApprovedByViewer(args: {
    organizationId: string;
    schemaCompositionErrors: Array<unknown> | null;
  }) {
    if (!this.getFailedSchemaCheckCanBeApproved(args)) {
      return false;
    }

    if (!this.authManager.isUser()) {
      // TODO: support approving a schema check via non web app user?
      return false;
    }

    const user = await this.authManager.getCurrentUser();
    const scopes = await this.authManager.getMemberTargetScopes({
      user: user.id,
      organization: args.organizationId,
    });

    return scopes.includes(TargetAccessScope.REGISTRY_WRITE);
  }

  /**
   * Approve a schema check that failed due to breaking changes.
   * You cannot approve a schema check that failed because composition failed.
   */
  async approveFailedSchemaCheck(args: {
    targetId: string;
    projectId: string;
    organizationId: string;
    schemaCheckId: string;
  }) {
    this.logger.debug('Manually approve failed schema check (args=%o)', args);

    await this.authManager.ensureTargetAccess({
      target: args.targetId,
      project: args.projectId,
      organization: args.organizationId,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    let [schemaCheck, viewer] = await Promise.all([
      this.storage.findSchemaCheck({
        targetId: args.targetId,
        schemaCheckId: args.schemaCheckId,
      }),
      this.authManager.getCurrentUser(),
    ]);

    if (schemaCheck == null) {
      this.logger.debug('Schema check not found (args=%o)', args);
      return {
        type: 'error',
        reason: "Schema check doesn't exist.",
      } as const;
    }

    if (schemaCheck.isSuccess) {
      this.logger.debug('Schema check is not failed (args=%o)', args);
      return {
        type: 'error',
        reason: 'Schema check is not failed.',
      } as const;
    }

    if (!this.getFailedSchemaCheckCanBeApproved(schemaCheck)) {
      this.logger.debug(
        'Schema check has composition errors or schema policy errors (args=%o).',
        args,
      );
      return {
        type: 'error',
        reason: 'Schema check has composition errors.',
      } as const;
    }

    if (schemaCheck.githubCheckRunId) {
      this.logger.debug('Attempt updating GitHub schema check. (args=%o).', args);
      const project = await this.projectManager.getProject({
        organization: args.organizationId,
        project: args.projectId,
      });
      if (!project.gitRepository) {
        this.logger.debug(
          'Skip updating GitHub schema check. Project has no git repository connected. (args=%o).',
          args,
        );
      } else {
        const [owner, repository] = project.gitRepository.split('/');
        const result = await this.githubIntegrationManager.updateCheckRunToSuccess({
          organizationId: args.organizationId,
          checkRun: {
            owner,
            repository,
            checkRunId: schemaCheck.githubCheckRunId,
          },
        });

        // In case updating the check run fails, we don't want to update our database state.
        // Instead, we want to return the error to the user and inform him that there is an issue with GitHub
        // and he needs to try again later.
        if (result?.type === 'error') {
          return {
            type: 'error',
            reason: result.reason,
          } as const;
        }
      }
    }

    schemaCheck = await this.storage.approveFailedSchemaCheck({
      schemaCheckId: args.schemaCheckId,
      userId: viewer.id,
    });

    if (!schemaCheck) {
      return {
        type: 'error',
        reason: "Schema check doesn't exist.",
      } as const;
    }

    return {
      type: 'ok',
      schemaCheck: inflateSchemaCheck(schemaCheck),
    } as const;
  }

  async getApprovedByUser(args: { organizationId: string; userId: string | null }) {
    if (args.userId == null) {
      return null;
    }

    return this.storage.getOrganizationUser({
      organizationId: args.organizationId,
      userId: args.userId,
    });
  }

  async getSchemaVersionByActionId(args: { actionId: string }) {
    const [target, organization] = await Promise.all([
      this.targetManager.getTargetFromToken(),
      this.organizationManager.getOrganizationFromToken(),
    ]);

    this.logger.debug('Fetch schema version by action id. (args=%o)', {
      projectId: target.projectId,
      targetId: target.id,
      actionId: args.actionId,
    });

    await this.authManager.ensureTargetAccess({
      organization: organization.id,
      project: target.projectId,
      target: target.id,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const record = await this.storage.getSchemaVersionByActionId({
      projectId: target.projectId,
      targetId: target.id,
      actionId: args.actionId,
    });

    if (!record) {
      return null;
    }

    return {
      ...record,
      project: target.projectId,
      target: target.id,
      organization: organization.id,
    };
  }

  checkProjectNativeFederationSupport(input: {
    project: Pick<Project, 'id' | 'legacyRegistryModel' | 'nativeFederation'>;
    organization: Pick<Organization, 'id' | 'featureFlags'>;
  }) {
    if (input.project.nativeFederation === false) {
      return false;
    }

    if (input.project.legacyRegistryModel === true) {
      this.logger.warn(
        'Project is using legacy registry model, ignoring native Federation support (organization=%s, project=%s)',
        input.organization.id,
        input.project.id,
      );
      return false;
    }

    if (input.organization.featureFlags.compareToPreviousComposableVersion === false) {
      this.logger.warn(
        'Organization has compareToPreviousComposableVersion FF disabled, ignoring native Federation support (organization=%s, project=%s)',
        input.organization.id,
        input.project.id,
      );
      return false;
    }

    this.logger.debug(
      'Native Federation support available (organization=%s, project=%s)',
      input.organization.id,
      input.project.id,
    );
    return true;
  }
}

/**
 * Takes a schema check as read from the database and inflates it to the proper business logic type.
 */
export function inflateSchemaCheck(schemaCheck: SchemaCheck) {
  if (schemaCheck.isSuccess) {
    return {
      ...schemaCheck,
      safeSchemaChanges:
        // TODO: fix any type
        schemaCheck.safeSchemaChanges?.map((check: any) => schemaChangeFromMeta(check)) ?? null,
      // TODO: fix any type
      breakingSchemaChanges:
        schemaCheck.breakingSchemaChanges?.map((check: any) => schemaChangeFromMeta(check)) ?? null,
    };
  }

  return {
    ...schemaCheck,
    safeSchemaChanges:
      // TODO: fix any type
      schemaCheck.safeSchemaChanges?.map((check: any) => schemaChangeFromMeta(check)) ?? null,
    // TODO: fix any type
    breakingSchemaChanges:
      schemaCheck.breakingSchemaChanges?.map((check: any) => schemaChangeFromMeta(check)) ?? null,
  };
}

/**
 * Schema check with all the fields inflated to their proper types.
 */
export type InflatedSchemaCheck = ReturnType<typeof inflateSchemaCheck>;
