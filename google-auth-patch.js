"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _koaPassport = _interopRequireDefault(require("@outlinewiki/koa-passport"));
var _koaRouter = _interopRequireDefault(require("koa-router"));
var _capitalize = _interopRequireDefault(require("lodash/capitalize"));
var _passportGoogleOauth = require("passport-google-oauth2");
var _i18n = require("./../../../../shared/i18n");
var _domains = require("./../../../../shared/utils/domains");
var _accountProvisioner = _interopRequireDefault(require("./../../../../server/commands/accountProvisioner"));
var _errors = require("./../../../../server/errors");
var _passport = _interopRequireDefault(require("./../../../../server/middlewares/passport"));
var _models = require("./../../../../server/models");
var _passport2 = require("./../../../../server/utils/passport");
var _plugin = _interopRequireDefault(require("../../plugin.json"));
var _env = _interopRequireDefault(require("../env"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const router = new _koaRouter.default();
const scopes = ["https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email"];
if (_env.default.GOOGLE_CLIENT_ID && _env.default.GOOGLE_CLIENT_SECRET) {
  _koaPassport.default.use(new _passportGoogleOauth.Strategy({
    clientID: _env.default.GOOGLE_CLIENT_ID,
    clientSecret: _env.default.GOOGLE_CLIENT_SECRET,
    callbackURL: `${_env.default.URL}/auth/${_plugin.default.id}.callback`,
    passReqToCallback: true,
    // @ts-expect-error StateStore
    store: new _passport2.StateStore(),
    scope: scopes
  }, async function (ctx, accessToken, refreshToken, params, profile, done) {
    try {
      // "domain" is the Google Workspaces domain
      const domain = profile._json.hd;
      const team = await (0, _passport2.getTeamFromContext)(ctx);
      const client = (0, _passport2.getClientFromOAuthState)(ctx);

      // No profile domain means personal gmail account
      // No team implies the request came from the apex domain
      // This combination is always an error
      if (!domain && !team) {
        const userExists = await _models.User.count({
          where: {
            email: profile.email.toLowerCase()
          },
          include: [{
            association: "team",
            required: true
          }]
        });

        // Users cannot create a team with personal gmail accounts
        // if (!userExists) {
        //   throw (0, _errors.GmailAccountCreationError)();
        // }

        // To log-in with a personal account, users must specify a team subdomain
        // throw (0, _errors.TeamDomainRequiredError)();
      }

      // remove the TLD and form a subdomain from the remaining
      // subdomains of the form "foo.bar.com" are allowed as primary Google Workspaces domains
      // see https://support.google.com/nonprofits/thread/19685140/using-a-subdomain-as-a-primary-domain
      const defaultSubdomain = profile.email.split("@")[0];
      const subdomain = domain ? (0, _domains.slugifyDomain)(domain) : (0, _domains.slugifyDomain)(defaultSubdomain);
      const teamName = domain ? (0, _capitalize.default)(subdomain) : (0, _capitalize.default)(defaultSubdomain) + " Workspace";

      // Request a larger size profile picture than the default by tweaking
      // the query parameter.
      const avatarUrl = profile.picture.replace("=s96-c", "=s128-c");
      const locale = profile._json.locale;
      const language = locale ? _i18n.languages.find(l => l.startsWith(locale)) : undefined;

      // if a team can be inferred, we assume the user is only interested in signing into
      // that team in particular; otherwise, we will do a best effort at finding their account
      // or provisioning a new one (within AccountProvisioner)
      const authCtx = { ip: ctx.ip, state: ctx.state || {} };
      const result = await (0, _accountProvisioner.default)(authCtx, {
        team: {
          teamId: team?.id,
          name: teamName,
          domain,
          subdomain
        },
        user: {
          email: profile.email,
          name: profile.displayName,
          language,
          avatarUrl
        },
        authenticationProvider: {
          name: _plugin.default.id,
          providerId: domain ?? ""
        },
        authentication: {
          providerId: profile.id,
          accessToken,
          refreshToken,
          expiresIn: params.expires_in,
          scopes
        }
      });
      return done(null, result.user, {
        ...result,
        client
      });
    } catch (err) {
      return done(err, null);
    }
  }));
  router.get(_plugin.default.id, _koaPassport.default.authenticate(_plugin.default.id, {
    accessType: "offline",
    prompt: "select_account consent"
  }));
  router.get(`${_plugin.default.id}.callback`, (0, _passport.default)(_plugin.default.id));
}
var _default = exports.default = router;