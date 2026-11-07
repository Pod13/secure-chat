#![allow(clippy::unwrap_used)]

mod fakes;

use fakes::FakeClock;
use serde_json::Value as Json;
use server::logging::{Level, Logger, TruncatedIp, Value, verify_chain};
use std::net::IpAddr;

fn three_lines() -> Vec<String> {
    let mut logger = Logger::new(Vec::new(), FakeClock::at(1_000));
    logger.log(Level::Info, "device_login", &[("ok", Value::Flag(true))]);
    logger.log(Level::Warn, "rate_limited", &[("hits", Value::Count(31))]);
    logger.log(
        Level::Error,
        "queue_full",
        &[("reason", Value::Label("limit"))],
    );
    logger.into_sink()
}

#[test]
fn a_line_carries_time_level_event_and_fields() {
    let lines = three_lines();
    let first: Json = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(first["at"], 1_000);
    assert_eq!(first["level"], "info");
    assert_eq!(first["event"], "device_login");
    assert_eq!(first["fields"]["ok"], true);
    assert_eq!(first["prev"], "0".repeat(64));
}

#[test]
fn an_untouched_log_verifies() {
    assert_eq!(verify_chain(&three_lines()), Ok(()));
    assert_eq!(verify_chain(&[]), Ok(()));
}

#[test]
fn editing_a_value_is_detected_at_that_line() {
    let mut lines = three_lines();
    lines[1] = lines[1].replace("31", "3");
    assert_eq!(verify_chain(&lines), Err(1));
}

#[test]
fn removing_a_middle_line_is_detected() {
    let mut lines = three_lines();
    lines.remove(1);
    assert_eq!(verify_chain(&lines), Err(1));
}

#[test]
fn reordering_lines_is_detected() {
    let mut lines = three_lines();
    lines.swap(0, 1);
    assert_eq!(verify_chain(&lines), Err(0));
}

#[test]
fn a_forged_hash_is_detected() {
    let mut line: Json = serde_json::from_str(&three_lines()[0]).unwrap();
    line["hash"] = Json::String("a".repeat(64));
    assert_eq!(verify_chain(&[line.to_string()]), Err(0));
}

#[test]
fn a_missing_hash_or_bad_json_is_detected() {
    let no_hash = r#"{"at":1,"level":"info","event":"x","fields":{},"prev":"0"}"#.to_string();
    assert_eq!(verify_chain(&[no_hash]), Err(0));
    assert_eq!(verify_chain(&["not json".to_string()]), Err(0));
    assert_eq!(verify_chain(&["[1,2]".to_string()]), Err(0));
}

#[test]
fn ip_addresses_lose_their_host_part() {
    let v4 = TruncatedIp::new("192.0.2.77".parse::<IpAddr>().unwrap());
    let v6 = TruncatedIp::new("2001:db8:abcd:1234:5678::1".parse::<IpAddr>().unwrap());
    assert_eq!(format!("{v4:?}"), r#"TruncatedIp("192.0.2.0")"#);
    assert_eq!(format!("{v6:?}"), r#"TruncatedIp("2001:db8:abcd::")"#);
}

#[test]
fn a_logged_ip_appears_only_in_truncated_form() {
    let mut logger = Logger::new(Vec::new(), FakeClock::at(5));
    let ip = TruncatedIp::new("203.0.113.9".parse::<IpAddr>().unwrap());
    logger.log(Level::Info, "request", &[("from", Value::Ip(ip))]);
    let line = logger.into_sink().remove(0);
    assert!(
        line.contains("203.0.113.0") && !line.contains("203.0.113.9"),
        "{line}"
    );
}

#[test]
fn stdout_sink_accepts_lines() {
    use server::logging::{LogSink, StdoutSink};
    StdoutSink.write_line("{}");
}
