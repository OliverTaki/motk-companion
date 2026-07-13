import assert from "node:assert/strict";
import { checkEnvironmentSeparation } from "../scripts/check-environment-separation.mjs";

function fixture(environment, suffix) {
  return {
    name: `motk-companion-${suffix}`,
    workers_dev: environment !== "production",
    vars: { MOTK_ENVIRONMENT: environment },
    d1_databases: [{
      binding: "CONTROL_DB",
      database_name: `motk-control-${suffix}`,
      database_id: `00000000-0000-4000-8000-00000000000${suffix === "development" ? "1" : "2"}`,
    }],
  };
}

const development = fixture("development", "development");
const preproduction = fixture("preproduction", "preproduction");
const publicBeta = fixture("public-beta", "public-beta");
const production = fixture("production", "production");

assert.equal(checkEnvironmentSeparation(development, preproduction).ok, true);
assert.equal(checkEnvironmentSeparation(development, publicBeta).ok, true);
assert.equal(checkEnvironmentSeparation(development, production).ok, true);

const sharedWorker = structuredClone(production);
sharedWorker.name = development.name;
assert.match(checkEnvironmentSeparation(development, sharedWorker).errors.join("\n"), /worker names/);

const sharedDatabase = structuredClone(production);
sharedDatabase.d1_databases[0] = structuredClone(development.d1_databases[0]);
assert.match(checkEnvironmentSeparation(development, sharedDatabase).errors.join("\n"), /database names/);
assert.match(checkEnvironmentSeparation(development, sharedDatabase).errors.join("\n"), /database ids/);

const exposedSecret = structuredClone(production);
exposedSecret.vars.ADMIN_TOKEN = "must-not-live-in-config";
assert.match(checkEnvironmentSeparation(development, exposedSecret).errors.join("\n"), /secret-like keys/);

const unsafeProduction = structuredClone(production);
unsafeProduction.workers_dev = true;
assert.match(checkEnvironmentSeparation(development, unsafeProduction).errors.join("\n"), /workers.dev/);

console.log("Cloudflare environment separation self-test passed.");
