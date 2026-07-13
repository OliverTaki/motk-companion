const SECRET_KEY = /(secret|token|password|private[_-]?key|client[_-]?secret)/i;

function environmentName(config) {
  return String(config?.vars?.MOTK_ENVIRONMENT ?? "").trim().toLowerCase();
}

function controlDatabase(config) {
  return (config?.d1_databases ?? []).find((database) => database?.binding === "CONTROL_DB");
}

function walkForSecretKeys(value, path = "config", findings = []) {
  if (!value || typeof value !== "object") return findings;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (SECRET_KEY.test(key)) findings.push(nextPath);
    walkForSecretKeys(nested, nextPath, findings);
  }
  return findings;
}

export function checkEnvironmentSeparation(development, production) {
  const errors = [];
  const devEnvironment = environmentName(development);
  const prodEnvironment = environmentName(production);
  const devDatabase = controlDatabase(development);
  const prodDatabase = controlDatabase(production);

  if (devEnvironment !== "development") {
    errors.push("development config must declare MOTK_ENVIRONMENT=development");
  }
  if (!["preproduction", "public-beta", "production"].includes(prodEnvironment)) {
    errors.push("release config must declare MOTK_ENVIRONMENT=preproduction, public-beta, or production");
  }
  if (!development?.name || !production?.name || development.name === production.name) {
    errors.push("worker names must be present and different");
  }
  if (!devDatabase || !prodDatabase) {
    errors.push("both environments must bind CONTROL_DB");
  } else {
    if (!devDatabase.database_name || !prodDatabase.database_name || devDatabase.database_name === prodDatabase.database_name) {
      errors.push("D1 database names must be present and different");
    }
    if (!devDatabase.database_id || !prodDatabase.database_id || devDatabase.database_id === prodDatabase.database_id) {
      errors.push("D1 database ids must be present and different");
    }
  }
  if (prodEnvironment === "production" && production?.workers_dev !== false) {
    errors.push("production must disable workers.dev publication");
  }

  const secretKeys = [
    ...walkForSecretKeys(development, "development"),
    ...walkForSecretKeys(production, "release"),
  ];
  if (secretKeys.length) {
    errors.push(`secret-like keys must be configured with wrangler secret: ${secretKeys.join(", ")}`);
  }

  return { ok: errors.length === 0, errors };
}
