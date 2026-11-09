# pocket security


- Binds to `127.0.0.1` only by default. Every API call needs the local token that `attach` puts in the launcher; a provider key sent instead is rejected. Requests with a foreign `Host` header are refused (DNS-rebinding guard).
- Keys stay in the OS keychain: Windows Credential Manager, macOS Keychain, or the Secret Service on Linux (gnome-keyring, KeePassXC, via `secret-tool`). With no keychain, pocket refuses to store a key and says why. It never writes keys to disk and does not fall back to the Linux kernel keyring (keys there vanish on reboot).
- The config dir holds the policy, a key index (which providers have a key and when they were verified, never the key), the meter and the failover log.

## Your own keys only

pocket only ever sends each provider the key **you** stored for **that** provider. It never proxies one person's key for another, never mixes keys across providers, and does not support provider sign-ins whose terms forbid proxying (for example Gemini CLI or Antigravity OAuth logins). Free tiers come with their providers' terms; read them. Mistral's free Experiment plan may use your requests to train Mistral's models, so it is off in the default policy.
