# Personal release lines

This fork keeps two deployable branches:

- `personal/deploy` contains upstream `dev` plus stable personal features.
- `personal/experimental` contains the stable line plus `personal/extended-analytics`.

The **Sync personal deploy branches** workflow runs daily at 06:00 UTC and can also be started manually. It prepares both candidates locally, tests and builds both, then publishes them together with one atomic, non-force push. A merge conflict or failed gate leaves both remote branches unchanged.

Production deployment is intentionally separate from synchronization. Run **Deploy Firefly Pico** in `Jallermax/zenmoney-to-firefly-iii-migrator`, choose `stable` or `experimental`, and optionally supply an exact ref for a rollback. The workflow tests the selected immutable Pico commit before the self-hosted runner builds and deploys it.

Scheduled synchronization never deploys automatically. Keep ordinary feature work on feature branches and merge only the intended stable features into `personal/deploy`; the sync workflow will carry them forward with upstream changes.
