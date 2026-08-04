// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishTransports             -> record calls so tests can assert them
//   - setConfig / getStatus         -> record calls so tests can assert them
// This lets us test the pure wiring (discovery payloads, mapping, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys({ gladysVersion = '4.84.3' } = {}) {
  const published = [];
  const transports = [];
  const savedConfig = [];

  return {
    published,
    transports,
    savedConfig,

    externalIds(type, platformId) {
      const device = `ext:daikin-cloud:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({ featureExternalId: state.device_feature_external_id, state: state.state });
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConfig(partialConfig) {
      savedConfig.push(partialConfig);
      return { success: true };
    },

    async getStatus() {
      return { gladys_version: gladysVersion, service: { status: 'RUNNING' } };
    },
  };
}
