import { MongoMemoryReplSet } from "mongodb-memory-server";

export function databaseNameFromMongoUri(uri) {
  try {
    const parsed = new URL(String(uri || ""));
    if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) return "";
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("/")[0] || "");
  } catch {
    return "";
  }
}

export function assertDisposableTestMongoUri(uri) {
  const databaseName = databaseNameFromMongoUri(uri);
  if (!uri || !/_test$/i.test(databaseName)) {
    throw new Error("TEST_MONGODB_URI must target a database whose name ends with _test. No data was changed.");
  }
  return databaseName;
}

export async function acquireDisposableTestMongo({ databaseName = "clinic_integration_test" } = {}) {
  const configuredUri = process.env.TEST_MONGODB_URI;
  if (configuredUri) {
    return {
      uri: configuredUri,
      databaseName: assertDisposableTestMongoUri(configuredUri),
      managed: false,
      stop: async () => {}
    };
  }

  if (!/_test$/i.test(databaseName)) throw new Error("Disposable MongoDB database names must end with _test.");
  const replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ dbName: databaseName }]
  });
  const uri = replicaSet.getUri(databaseName);
  return {
    uri,
    databaseName: assertDisposableTestMongoUri(uri),
    managed: true,
    stop: () => replicaSet.stop()
  };
}
