# 壳层 cargo check

- commit: 5e22930324e99bc5b89f91e22481fb46499f65b8
- outcome: success
- run: https://github.com/Kide-Lee/HQ-SciFi/actions/runs/45027219107

```
[1m[92m    Updating[0m crates.io index
[1m[92m Downloading[0m crates ...
[1m[92m  Downloaded[0m cexpr v0.6.0
[1m[92m  Downloaded[0m clang-sys v1.9.1
[1m[92m  Downloaded[0m bindgen v0.69.5
[1m[92m  Downloaded[0m home v0.5.12
[1m[92m  Downloaded[0m itertools v0.12.1
[1m[92m  Downloaded[0m lazycell v1.3.0
[1m[92m  Downloaded[0m libloading v0.8.9
[1m[92m  Downloaded[0m minimal-lexical v0.2.1
[1m[92m  Downloaded[0m linux-raw-sys v0.4.15
[1m[92m  Downloaded[0m nom v7.1.3
[1m[92m  Downloaded[0m prettyplease v0.2.37
[1m[92m  Downloaded[0m rustc-hash v1.1.0
[1m[92m  Downloaded[0m rustix v0.38.44
[1m[92m  Downloaded[0m shlex v1.3.0
[1m[92m  Downloaded[0m which v4.4.2
[1m[92m   Compiling[0m hq-scifi v2.1.16 (/home/runner/work/HQ-SciFi/HQ-SciFi/src-tauri)
[1m[92m    Checking[0m hqsf-core v2.1.16 (/home/runner/work/HQ-SciFi/HQ-SciFi/crates/hqsf-core)
[1m[33mwarning[0m[1m: unused import: `crate::runtime::resources`[0m
  [1m[94m--> [0msrc/runtime/paths.rs:31:5
   [1m[94m|[0m
[1m[94m31[0m [1m[94m|[0m use crate::runtime::resources;
   [1m[94m|[0m     [1m[33m^^^^^^^^^^^^^^^^^^^^^^^^^[0m
   [1m[94m|[0m
   [1m[94m= [0m[1mnote[0m: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default

[1m[33mwarning[0m[1m: unused imports: `PathBuf` and `Path`[0m
  [1m[94m--> [0msrc/runtime/secrets.rs:19:17
   [1m[94m|[0m
[1m[94m19[0m [1m[94m|[0m use std::path::{Path, PathBuf};
   [1m[94m|[0m                 [1m[33m^^^^[0m  [1m[33m^^^^^^^[0m

[1m[33mwarning[0m[1m: constant `AGREEMENT` is never used[0m
  [1m[94m--> [0msrc/runtime/resources.rs:15:7
   [1m[94m|[0m
[1m[94m15[0m [1m[94m|[0m const AGREEMENT: &[u8] = include_bytes!("../../resources/agreement.md");
   [1m[94m|[0m       [1m[33m^^^^^^^^^[0m
   [1m[94m|[0m
   [1m[94m= [0m[1mnote[0m: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

[1m[33mwarning[0m[1m: constant `API_CONFIG` is never used[0m
  [1m[94m--> [0msrc/runtime/resources.rs:16:7
   [1m[94m|[0m
[1m[94m16[0m [1m[94m|[0m const API_CONFIG: &[u8] = include_bytes!("../../resources/api.config.json");
   [1m[94m|[0m       [1m[33m^^^^^^^^^^[0m

[1m[33mwarning[0m[1m: constant `CHANGELOG` is never used[0m
  [1m[94m--> [0msrc/runtime/resources.rs:17:7
   [1m[94m|[0m
[1m[94m17[0m [1m[94m|[0m const CHANGELOG: &[u8] = include_bytes!("../../resources/changelog.md");
   [1m[94m|[0m       [1m[33m^^^^^^^^^[0m

[1m[33mwarning[0m[1m: constant `FILES` is never used[0m
  [1m[94m--> [0msrc/runtime/resources.rs:19:7
   [1m[94m|[0m
[1m[94m19[0m [1m[94m|[0m const FILES: [(&str, &[u8]); 3] = [
   [1m[94m|[0m       [1m[33m^^^^^[0m

[1m[33mwarning[0m[1m: function `materialize` is never used[0m
  [1m[94m--> [0msrc/runtime/resources.rs:26:8
   [1m[94m|[0m
[1m[94m26[0m [1m[94m|[0m pub fn materialize(dir: &Path) -> CoreResult<PathBuf> {
   [1m[94m|[0m        [1m[33m^^^^^^^^^^^[0m

[1m[33mwarning[0m: `hq-scifi` (lib test) generated 7 warnings (7 duplicates)
[1m[33mwarning[0m: `hq-scifi` (lib) generated 7 warnings (run `cargo fix --lib -p hq-scifi` to apply 2 suggestions)
[1m[92m    Finished[0m `dev` profile [unoptimized + debuginfo] target(s) in 11.01s
```
