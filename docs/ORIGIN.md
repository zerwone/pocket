# Why pocket exists

Coding agents stop when their model's quota runs out. Mid-task, an agent gets a 429 or a "usage limit reached" message and the session ends: the plan, the open files, the half-done change all wait until the quota resets, often hours later. For one person running several agents on one repo, that happens every day, and usually while they are away.

Most people who hit this already hold keys that would keep the session going: free tiers from Groq, Cerebras, NVIDIA, OpenRouter or Mistral, each with its own daily allowance. Nothing connects those keys to the agent at the moment the paid quota runs out.

pocket is that connection, and nothing more:

- **Bring your own keys.** Every key belongs to the person running pocket and is used only for its own provider. No pooling, no sharing, no resale, no proxying of sign-ins whose terms forbid it. This keeps it legal and keeps each provider's terms between the user and that provider.
- **Local.** One daemon on `127.0.0.1`, keys in the OS keychain, no account, no telemetry, no hosted service.
- **Honest about quality.** A free-tier open model is weaker than the paid model the session started on. pocket keeps the agent running and says, in the session, which model is now answering and why. Degraded is acceptable; stopped is not.

It is a sister project to `staked` (path ownership, commit checks and a decision list for multi-agent repos): `staked` decides who may do what; pocket keeps each of those agents supplied with tokens. A `provider_policy` block in a staked `roles.yml` can give each agent its own provider order and daily cap. staked itself never calls a model.
