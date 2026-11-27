// The live-panel plugin keeps its unit tests beside the module
// (browser-plugin/live.test.mjs). Importing them here keeps `npm test` covering
// the shipped plugin logic without adding the Chromium worker suite (which the
// browser-worker keep-path runs separately) to the default project test run.
import '../browser-plugin/live.test.mjs'
import '../browser-plugin/live-tabs.test.mjs'
import '../browser-plugin/sidebar/client.test.mjs'
import '../browser-worker/browser-history.test.mjs'
