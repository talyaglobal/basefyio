/**
 * @keycloak/keycloak-admin-client ships as ES modules only, so requiring it
 * under ts-jest throws "Cannot use import statement outside a module" — and it
 * is imported by KeycloakAdminService, which half the services import in turn.
 * Any spec that so much as touched that import chain failed before it ran a
 * single assertion.
 *
 * Unit tests never talk to Keycloak: they inject their own double. This stub
 * stands in for the package so the import resolves, and it is deliberately
 * inert — reaching for a real method here is a mistake worth a loud failure.
 */
class KcAdminClient {
  constructor() {
    return new Proxy(this, {
      get(_target, prop) {
        throw new Error(
          `The Keycloak admin client is stubbed in tests; something called "${String(prop)}" on it. ` +
            'Inject a double for the Keycloak dependency instead.',
        );
      },
    });
  }
}

module.exports = KcAdminClient;
module.exports.default = KcAdminClient;
