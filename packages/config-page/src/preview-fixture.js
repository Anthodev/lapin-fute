// Public, credential-free projection of fixtures/departures/foundation.json.
// The test suite keeps this display-only preview synchronized with the recorded
// departure fixture without making live departure normalization a page dependency.
export const RECORDED_PREVIEW = Object.freeze([
  Object.freeze({ minutes: 2, status: "DELAYED" }),
  Object.freeze({ minutes: 6, status: "ON_TIME" }),
]);
