//! CLI wrapper: `memora-sentinel scan <build-dir> [--baseline <live-build-dir>]`
//! Prints a JSON report on stdout. Exit code: 0 clean, 1 review, 2 block, 64 usage.

use memora_sentinel::{scan, SourceFile, Verdict};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) -> std::io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for e in entries {
        let p = e.path();
        let ft = e.file_type()?;
        if ft.is_symlink() {
            continue; // never follow links out of the build directory
        }
        if ft.is_dir() {
            walk(root, &p, out)?;
        } else if e.metadata()?.len() <= MAX_FILE_BYTES {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            let bytes = fs::read(&p)?;
            out.push((rel, String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    Ok(())
}

fn load(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out).map_err(|e| format!("{}: {}", dir.display(), e))?;
    Ok(out)
}

fn usage() -> ExitCode {
    eprintln!("usage: memora-sentinel scan <build-dir> [--baseline <live-build-dir>]");
    ExitCode::from(64)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("scan") || args.len() < 2 {
        return usage();
    }
    let candidate_dir = PathBuf::from(&args[1]);
    let baseline_dir = match args.get(2).map(String::as_str) {
        Some("--baseline") => match args.get(3) {
            Some(d) => Some(PathBuf::from(d)),
            None => return usage(),
        },
        Some(_) => return usage(),
        None => None,
    };

    let candidate = match load(&candidate_dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(64);
        }
    };
    let baseline = match baseline_dir.as_deref().map(load).transpose() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(64);
        }
    };

    let cand: Vec<SourceFile> = candidate.iter().map(|(p, c)| SourceFile { path: p, content: c }).collect();
    let base: Option<Vec<SourceFile>> =
        baseline.as_ref().map(|b| b.iter().map(|(p, c)| SourceFile { path: p, content: c }).collect());

    let report = scan(&cand, base.as_deref());
    println!("{}", report.to_json());
    ExitCode::from(match report.verdict {
        Verdict::Clean => 0,
        Verdict::Review => 1,
        Verdict::Block => 2,
    })
}
