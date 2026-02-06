// macOS integration tests need to run in a single `flutter test -d macos` app
// session. Running multiple files in one invocation is flaky on Flutter stable
// (log reader/debug connection can fail between app launches).

import 'app_chat_e2e_macos_suite.dart' as app_chat_e2e;
import 'ndr_native_macos_suite.dart' as ndr_native;
import 'nostr_relay_roundtrip_macos_suite.dart' as relay_roundtrip;

void main() {
  ndr_native.main();
  app_chat_e2e.main();
  relay_roundtrip.main();
}
