"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _nodePath = _interopRequireDefault(require("node:path"));
var _fsExtra = require("fs-extra");
var _invariant = _interopRequireDefault(require("invariant"));
var _types = require("./../../shared/types");
var _WelcomeEmail = _interopRequireDefault(require("./../emails/templates/WelcomeEmail"));
var _env = _interopRequireDefault(require("./../env"));
var _errors = require("./../errors");
var _Logger = _interopRequireDefault(require("./../logging/Logger"));
var _tracing = require("./../logging/tracing");
var _models = require("./../models");
var _DocumentHelper = require("./../models/helpers/DocumentHelper");
var _database = require("./../storage/database");
var _PluginManager = require("./../utils/PluginManager");
var _groupsSyncer = _interopRequireDefault(require("./groupsSyncer"));
var _teamProvisioner = _interopRequireDefault(require("./teamProvisioner"));
var _userProvisioner = _interopRequireDefault(require("./userProvisioner"));
var _dateFns = require("date-fns");
var _context = require("./../context");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
async function accountProvisioner(ctx, _ref) {
  let {
    user: userParams,
    team: teamParams,
    authenticationProvider: authenticationProviderParams,
    authentication: authenticationParams
  } = _ref;
  let result;
  let emailMatchOnly;
  const actor = ctx.state.auth?.user;

  // If the user is already logged in and is an admin of the team then we
  // allow them to connect a new authentication provider
  if (actor && actor.teamId === teamParams.teamId && actor.isAdmin) {
    const team = actor.team;
    let authenticationProvider = await _models.AuthenticationProvider.findOne({
      where: {
        ...authenticationProviderParams,
        teamId: team.id
      }
    });
    if (!authenticationProvider) {
      authenticationProvider = await team.$create("authenticationProvider", authenticationProviderParams);
    }
    return {
      user: actor,
      team,
      isNewUser: false,
      isNewTeam: false
    };
  }
  try {
    result = await (0, _teamProvisioner.default)(ctx, {
      ...teamParams,
      name: teamParams.name || "Wiki",
      authenticationProvider: authenticationProviderParams
    });
  } catch (err) {
    // The account could not be provisioned for the provided teamId
    // check to see if we can try authentication using email matching only
    if (err.id === "invalid_authentication") {
      const authProvider = await _models.AuthenticationProvider.findOne({
        where: {
          name: authenticationProviderParams.name,
          teamId: teamParams.teamId
        },
        include: [{
          model: _models.Team,
          as: "team",
          required: true
        }],
        order: [["enabled", "DESC"]]
      });
      if (authProvider) {
        emailMatchOnly = true;
        result = {
          authenticationProvider: authProvider,
          team: authProvider.team,
          isNewTeam: false
        };
      }
    }
    if (!result) {
      if (err.id) {
        throw err;
      } else {
        throw (0, _errors.InvalidAuthenticationError)(err.message);
      }
    }
  }
  (0, _invariant.default)(result, "Team creator result must exist");
  const {
    authenticationProvider,
    team,
    isNewTeam
  } = result;
  if (!authenticationProvider.enabled) {
    throw (0, _errors.AuthenticationProviderDisabledError)();
  }
  result = await (0, _userProvisioner.default)(ctx, {
    name: userParams.name,
    email: userParams.email,
    language: userParams.language,
    role: isNewTeam ? _types.UserRole.Admin : undefined,
    avatarUrl: userParams.avatarUrl,
    teamId: team.id,
    authentication: emailMatchOnly ? undefined : {
      authenticationProviderId: authenticationProvider.id,
      ...authenticationParams,
      expiresAt: authenticationParams.expiresIn ? (0, _dateFns.addSeconds)(Date.now(), authenticationParams.expiresIn) : undefined
    }
  });
  const {
    isNewUser,
    user
  } = result;

  // TODO: Move to processor
  if (isNewUser) {
    await new _WelcomeEmail.default({
      to: user.email,
      role: user.role,
      teamUrl: team.url
    }).schedule();
  }
  if (isNewUser || isNewTeam) {
    let provision = isNewTeam;

    // accounts for the case where a team is provisioned, but the user creation
    // failed. In this case we have a valid previously created team but no
    // onboarding collection.
    if (!isNewTeam) {
      const count = await _models.Collection.count({
        where: {
          teamId: team.id
        }
      });
      provision = count === 0;
    }
    if (provision) {
      await provisionFirstCollection(ctx, team, user);
    }
  }

  // Sync group memberships from the authentication provider if enabled
  if (authenticationParams.accessToken) {
    const settings = authenticationProvider.settings;
    if (settings?.groupSyncEnabled) {
      const syncProvider = _PluginManager.PluginManager.getGroupSyncProvider(authenticationProviderParams.name);
      if (syncProvider) {
        try {
          const externalGroups = await syncProvider.fetchUserGroups(authenticationParams.accessToken, settings);
          await _database.sequelize.transaction(async transaction => {
            const groupSyncCtx = (0, _context.createContext)({
              user,
              ip: ctx.context?.ip,
              transaction
            });
            await (0, _groupsSyncer.default)(groupSyncCtx, {
              user,
              team,
              authenticationProvider,
              externalGroups
            });
          });
        } catch (err) {
          // Group sync failure should never block login
          _Logger.default.error("Group sync failed during login", err, {
            userId: user.id,
            provider: authenticationProviderParams.name
          });
        }
      }
    }
  }
  return {
    user,
    team,
    isNewUser,
    isNewTeam
  };
}
async function provisionFirstCollection(ctx, team, user) {
  await _database.sequelize.transaction(async transaction => {
    const context = (0, _context.createContext)({
      ...ctx,
      transaction,
      user
    });
    const collection = await _models.Collection.createWithCtx(context, {
      name: "Welcome",
      description: `This collection is a quick guide to what ${_env.default.APP_NAME} is all about. Feel free to delete this collection once your team is up to speed with the basics!`,
      teamId: team.id,
      createdById: user.id,
      sort: _models.Collection.DEFAULT_SORT,
      permission: _types.CollectionPermission.ReadWrite
    });

    // For the first collection we go ahead and create some initial documents to get
    // the team started. You can edit these in /server/onboarding/x.md
    const onboardingDocs = ["Integrations & API", "Our Editor", "Getting Started", "What is Outline"];
    for (const title of onboardingDocs) {
      const text = await (0, _fsExtra.readFile)(_nodePath.default.join(process.cwd(), "server", "onboarding", `${title}.md`), "utf8");
      const document = await _models.Document.createWithCtx(context, {
        version: 2,
        isWelcome: true,
        parentDocumentId: null,
        collectionId: collection.id,
        teamId: collection.teamId,
        lastModifiedById: collection.createdById,
        createdById: collection.createdById,
        title,
        text
      });
      document.content = await _DocumentHelper.DocumentHelper.toJSON(document);
      await document.publish(context, {
        collectionId: collection.id,
        silent: true
      });
    }
  });
}
var _default = exports.default = (0, _tracing.traceFunction)({
  spanName: "accountProvisioner"
})(accountProvisioner);