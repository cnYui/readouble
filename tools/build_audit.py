#!/usr/bin/env python3
"""Generate docs/aiui-audit.md from a fresh capability inventory.

Every row is emitted BLOCKED with per-layer reasons: no RUNNER/STUDIO/DEVICE
signing authority exists on this workstation, so no executed layer can be
claimed. Run from the repository root:

    python tools/build_audit.py

It re-runs the skill's inventory scanner so the audit always binds the current
worktree fingerprint.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
IMPORT_ROOT = "agent"
VERSION = "0.17.0"
SKILL_SCRIPTS = Path.home() / ".claude" / "skills" / "rokid-aiui-agent" / "scripts"
REV = "88e70bb0382525c1a93ef077c2401dcc31a273ce"
BLOB = f"https://github.com/yodaos-project/AIUI/blob/{REV}/"
TREE = f"https://github.com/yodaos-project/AIUI/tree/{REV}/"

BLOCKED_REASONS = {
    "SOURCE": "no source-inspection capture manifest for the current revision",
    "STATIC": "no RUNNER-signed schema-2 manifest for the current revision",
    "LOGIC": "no RUNNER-signed schema-2 manifest for the current revision",
    "AIX": "aix pack and list ran through npx @yodaos-pkg/aix-cli@0.8.2 without a RUNNER-signed capture manifest",
    "STUDIO": "Studio simulation observed manually without a STUDIO-signed capture manifest",
    "DEVICE": "no physical Rokid Glasses session for the current revision",
}
LAYER_ORDER = ["SOURCE", "STATIC", "LOGIC", "AIX", "STUDIO", "DEVICE"]

UX_ROWS = [
    ("UX-TARGET", "all-targets", "Every supported `_current`, `_blank`, and transition", "Wrong density, host behavior, or business-state drift", "Exercise each declared surface and target change with the same input", ["LOGIC", "STUDIO", "DEVICE"]),
    ("UX-STATE", "all-states", "Every loading, empty, ready, active, success, error, denied, and recovery state used by the product", "Hidden, misleading, or dead-end states", "Reach each state and every legal and illegal transition", ["LOGIC", "AIX", "STUDIO", "DEVICE"]),
    ("UX-TEXT", "boundary-text", "Empty, minimum, maximum, long Chinese/English, mixed Unicode, and malformed input", "Clipping, unreadable wrapping, unsafe interpolation, or hidden actions", "Exercise boundary values, overflow, scrolling, and fixed-action visibility", ["LOGIC", "AIX", "STUDIO", "DEVICE"]),
    ("UX-FOCUS", "focus-model", "Host and every actionable element", "Invisible focus, focus trap, or unfocused activation", "Exercise host focus/blur, element focus/blur, order, activation, and return", ["STATIC", "STUDIO", "DEVICE"]),
    ("UX-INPUT", None, "One claimed tap, Enter, Back, directional, touchpad, voice, or gesture path", "Double action, stolen host default, unsupported event, or no fallback", "Exercise owned and ignored input, default prevention, and a non-sensor fallback", ["LOGIC", "STUDIO", "DEVICE"]),
    ("UX-RECOVERY", "failure-recovery", "Offline, timeout, denied, unavailable, invalid, and retry states that apply", "Silent failure or endless retry", "Force each failure, verify useful feedback, bounded retry, back/finish, and recovery", ["STATIC", "LOGIC", "STUDIO", "DEVICE"]),
    ("UX-LIFECYCLE", "page-lifecycle", "First open, hide/show, unload/reopen, and repeated attach/open where applicable", "Stale state, duplicate work, leaked timers/listeners, or wrong resume", "Exercise lifecycle ordering, state reconciliation, and cleanup", ["LOGIC", "STUDIO", "DEVICE"]),
    ("UX-VISUAL", "visual-system", "Every meaningful state and focus level", "Meaning conveyed only by green luminance, weak hierarchy, excess fill, or clutter", "Check labels/shapes plus luminance, typography, spacing, line weight, fill, and information density", ["STATIC", "AIX", "DEVICE"]),
    ("UX-ENVIRONMENT", "optical-scenes", "Runtime viewport and bright, dark, and cluttered real scenes", "Desktop-readable UI fails in physical optics", "Inspect the actual viewport, comfortable region, backgrounds, posture, and motion", ["AIX", "DEVICE"]),
    ("UX-MOTION", "motion-performance", "Transitions, animation, repeated navigation, and continuous use", "Distraction, unsupported motion, dropped frames, heat, or instability", "Exercise reduced/absent motion fallback, overlap, cold start, and endurance as applicable", ["LOGIC", "STUDIO", "DEVICE"]),
]

ALL = LAYER_ORDER
SSLAS = ["SOURCE", "STATIC", "LOGIC", "AIX", "STUDIO"]
SSLSD = ["SOURCE", "STATIC", "LOGIC", "STUDIO", "DEVICE"]
SSSD = ["SOURCE", "STATIC", "STUDIO", "DEVICE"]

APP_JSON_DOC = BLOB + "documentation/1-framework/open-agent-format/app-json.en-US.md"
TARGET_DOC = BLOB + "documentation/1-framework/open-agent-format/target.en-US.md"
FOCUS_DOC = BLOB + "documentation/1-framework/open-agent-format/focus.en-US.md"
PAGE_EVENTS_DOC = BLOB + "documentation/1-framework/open-agent-format/page-events.en-US.md"
OPEN_AGENT_INDEX = TREE + "documentation/1-framework/open-agent-format"
COMPONENT_INDEX = TREE + "documentation/2-components"
AI_INDEX = TREE + "documentation/3-api/ai"
PAGE_API_DOC = BLOB + "documentation/3-api/framework/page.en-US.md"
MEDIA_DOC = BLOB + "documentation/3-api/media/media-capture.en-US.md"
SPEECH_DOC = BLOB + "documentation/3-api/ai/speech-recognition.en-US.md"
SCROLL_VIEW_DOC = BLOB + "documentation/2-components/scroll-view.en-US.md"
PERMISSION_LINE = BLOB + "samples/capabilities/app.json#L57"
MEDIA_SAMPLE = BLOB + "samples/capabilities/pages/media_devices/index.ink"
SPEECH_SAMPLE = BLOB + "samples/capabilities/pages/speech/index.ink"

# family -> (base id, layer union, human label for unresolved rows, source entries)
POLICY = {
    "page.route": ("CAP-PAGE-ROUTE", SSLAS, None, [("DOC", "app.json", APP_JSON_DOC)]),
    "page.target": ("CAP-PAGE-TARGET", ALL, None, [("DOC", "target", TARGET_DOC)]),
    "focus.host": ("CAP-HOST-FOCUS", SSSD, None, [("DOC", "focus", FOCUS_DOC)]),
    "input.enter": ("CAP-INPUT-ENTER", SSLSD, None, [("DOC", "Page events", PAGE_EVENTS_DOC)]),
    "input.back": ("CAP-INPUT-BACK", SSLSD, None, [("DOC", "Page events", PAGE_EVENTS_DOC)]),
    "input.key.unknown": ("CAP-INPUT-KEY", SSLSD, "Unresolved key input", [("DOC", "Page events", PAGE_EVENTS_DOC)]),
    "input.scroll.host": ("CAP-INPUT-SCROLL-HOST", SSLSD, None, [("DOC", "Page events", PAGE_EVENTS_DOC)]),
    "component.scroll-view": ("CAP-SCROLL-VIEW", ALL, None, [("DOC", "scroll-view", SCROLL_VIEW_DOC)]),
    "input.voice.unknown": ("CAP-VOICE", SSLSD, "Unresolved voice input", [("SEARCH-SCOPE", "Page/open-agent-format index", OPEN_AGENT_INDEX), ("SEARCH-SCOPE", "AI API index", AI_INDEX)]),
    "voice.declaration.unknown": ("CAP-VOICE-DECLARATION", SSSD, "Unresolved voice declaration", [("SEARCH-SCOPE", "Page/open-agent-format index", OPEN_AGENT_INDEX), ("SEARCH-SCOPE", "AI API index", AI_INDEX)]),
    "ai.speech-recognition": ("CAP-SPEECH-RECOGNITION", SSLSD, None, [("DOC", "speech recognition", SPEECH_DOC), ("SAMPLE", "speech implementation", SPEECH_SAMPLE)]),
    "media.camera.permission": ("CAP-CAMERA-PERMISSION", SSSD, None, [("DOC", "media capture", MEDIA_DOC), ("DECLARATION-SNIPPET", "CAMERA permission line 57", PERMISSION_LINE)]),
    "media.camera.runtime": ("CAP-CAMERA-RUNTIME", SSLSD, None, [("DOC", "media capture", MEDIA_DOC), ("SAMPLE", "media implementation", MEDIA_SAMPLE), ("DECLARATION-SNIPPET", "CAMERA line 57", PERMISSION_LINE)]),
    "media.camera.lifecycle": ("CAP-CAMERA-LIFECYCLE", SSLSD, None, [("DOC", "media capture", MEDIA_DOC), ("SAMPLE", "media implementation", MEDIA_SAMPLE), ("DECLARATION-SNIPPET", "CAMERA line 57", PERMISSION_LINE)]),
    "page.lifecycle": ("CAP-PAGE-LIFECYCLE", ALL, None, [("DOC", "Page API", PAGE_API_DOC)]),
    "project.unregistered": ("CAP-UNREGISTERED", ALL, "Unregistered project capability", [("SEARCH-SCOPE", "AIUI documentation index", TREE + "documentation"), ("SEARCH-SCOPE", "AIUI samples index", TREE + "samples")]),
}

BEHAVIOR = {
    "page.route": ("The declared route opens exactly one intended Page", "Missing, malformed, or rejected navigation preserves a usable exit", "Repeated navigation and unload leave no stale route-owned work"),
    "page.target": ("The declared target renders the intended layout and behavior", "Unsupported or changed targets preserve readable content and a usable fallback", "Target changes and repeated open reconcile without stale surface state"),
    "focus.host": ("Host focus enters and leaves the Page at the documented boundaries", "Blurred or unavailable host focus cannot trigger an unfocused action and preserves a usable return", "Hide/show and unload reconcile host focus without stale callbacks"),
    "input.enter": ("One owned Enter input invokes the intended action exactly once", "Ignored or repeated Enter input preserves host defaults and a non-key fallback", "Hide/show and unload do not retain stale Enter handling"),
    "input.back": ("One owned Back input performs the intended navigation or dismissal", "Ignored or repeated Back input preserves host defaults and a usable exit", "Hide/show and unload do not retain stale Back handling"),
    "input.key.unknown": ("The intended key input performs exactly one owned action", "Unknown, ignored, or repeated key delivery preserves host defaults and a non-key fallback", "Hide/show and unload do not retain stale key handling"),
    "input.scroll.host": ("Owned directional input scrolls only the intended content by a bounded amount", "Boundary, ignored, and repeated scrolling preserve host behavior without trapping input", "Hide/show and unload do not retain stale directional scroll handling"),
    "component.scroll-view": ("The scroll-view reveals intended overflow while preserving fixed actions", "Empty, short, boundary, and excessive content remain readable and recoverable", "Repeated render and reopen restore a valid bounded scroll state"),
    "input.voice.unknown": ("The declared product intent is delivered once", "No-match, unavailable, repeated, and ignored input use a non-voice fallback", "Hide/show and unload do not retain stale voice work"),
    "voice.declaration.unknown": ("The required declaration matches the inspected voice mechanism", "Missing, denied, or revoked access preserves a non-voice fallback", "Reopen reconciles the current declaration and access state"),
    "ai.speech-recognition": ("A started recognition session delivers one current transcript outcome", "No-match, denial, unavailability, error, and repeated delivery preserve a non-voice fallback", "Hide/show and unload stop or reconcile every recognition session and listener"),
    "media.camera.permission": ("The declared CAMERA permission matches the camera behavior used by the project", "Missing, denied, or revoked permission preserves an explicit non-camera fallback", "Reopen reconciles the current permission state without assuming prior access"),
    "media.camera.runtime": ("A granted camera request yields only the intended current video stream", "Denial, unavailability, constraint failure, and runtime error preserve an explicit fallback", "Hide/show and unload stop or reconcile every acquired camera track"),
    "media.camera.lifecycle": ("Every acquired camera track is owned by one current Page lifecycle", "Partial setup, revocation, and stop failure preserve explicit cleanup and recovery", "Hide/show and unload stop all tracks without retaining camera resources"),
    "page.lifecycle": ("Page callbacks establish the intended state once in documented lifecycle order", "Repeated, interrupted, and out-of-date work cannot overwrite the current Page state", "Hide/show and unload reconcile or release all Page-owned retained work"),
    "project.unregistered": ("The declared capability performs its claimed outcome once", "Unavailable, rejected, or ignored delivery preserves an explicit fallback", "Hide/show and unload do not retain stale capability work"),
}


POLICY["network.https"] = (
    "CAP-NETWORK-HTTPS",
    ALL,
    None,
    [
        ("DOC", "HTTPS", BLOB + "documentation/3-api/network/https.en-US.md"),
        ("SAMPLE", "HTTPS implementation", BLOB + "samples/capabilities/pages/network_https/index.ink"),
    ],
)
BEHAVIOR["network.https"] = (
    "A successful HTTPS request updates only the current intended state",
    "Offline, timeout, malformed, partial, and rejected responses use bounded retry and recovery",
    "Hide/show and unload cancel or reconcile every retained HTTPS request",
)


def run_inventory() -> dict:
    result = subprocess.run(
        [sys.executable, str(SKILL_SCRIPTS / "inventory_aiui_capabilities.py"), IMPORT_ROOT,
         "--target-version", VERSION, "--repository-root", "."],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return json.loads(result.stdout)


def evidence(layers: list[str]) -> str:
    return "; ".join(f"{layer}=blocked:{BLOCKED_REASONS[layer]}" for layer in layers)


def layers_text(layers: list[str]) -> str:
    return ", ".join(layers)


def contract(family: str, path: str, text: str) -> str:
    return f"{{contract=cap-{family.replace('.', '-')}-v1}} {{path={path}}} {text}"


def capability_row(item: dict, surfaces: list[str]) -> tuple[str, list[str], str]:
    family = item["family"]
    if family not in POLICY:
        raise SystemExit(f"no audit policy for family {family}; extend tools/build_audit.py")
    base, layers, human_label, sources = POLICY[family]
    gate = item["gate"]
    hex_suffix = gate.rsplit("-", 1)[1].upper()
    provisional = item["policyState"] == "binding-unresolved"
    mechanism = item["mechanism"]
    location = item["locations"][0]
    where = f"{location['path']}:{location['line']}"
    if family == "project.unregistered":
        identifier = f"{base}-{hex_suffix}"
        label = human_label
    elif provisional:
        identifier = f"{base}-{hex_suffix}-PROVISIONAL"
        label = f"{mechanism} at {where}" if mechanism.startswith("CLAIM:") else human_label
    else:
        identifier = f"{base}-{hex_suffix}"
        label = f"{mechanism} at {where}"
    if mechanism.startswith("CLAIM:") and "@" in mechanism:
        surface = mechanism.split("@", 1)[1].split(":", 1)[0]
    elif mechanism.startswith("target:"):
        surface = mechanism.split(":", 1)[1]
    else:
        surface = ",".join(surfaces)
    source_cell = "; ".join(f"{role}=[{text}]({url})" for role, text, url in sources)
    positive, negative, lifecycle = BEHAVIOR[family]
    cells = [
        f"[{identifier}] {{family={family}}} {{gate={gate}}} {label}",
        f"AIUI {VERSION}; device=UNAVAILABLE; surface={surface}",
        item["apiBinding"],
        item["declarationBinding"],
        source_cell,
        contract(family, "positive", positive),
        contract(family, "negative-fallback", negative),
        contract(family, "lifecycle-cleanup", lifecycle),
        layers_text(layers),
        "BLOCKED",
        evidence(layers),
    ]
    return identifier, layers, "| " + " | ".join(cells) + " |"


def main() -> None:
    inventory = run_inventory()
    surfaces = list(inventory["supportedSurfaces"])
    input_gates = sorted(f"{g['kind']}@{g['gate']}" for g in inventory["inputGates"])
    claimed = sorted(inventory["claimedCapabilities"])
    lines = [
        f"Project revision: {inventory['projectRevision']}",
        f"Canonical version: AIUI {VERSION}",
        f"Import root: {IMPORT_ROOT}",
        "Device/host: UNAVAILABLE",
        f"Supported surfaces: {','.join(surfaces) if surfaces else 'UNAVAILABLE'}",
        f"Inputs: {','.join(input_gates) if input_gates else 'none'}",
        f"Claimed capabilities: {','.join(claimed)}",
        "",
        "## Project UX evidence matrix",
        "",
        "| ID | Surface/state | Risk | Test | Evidence layer | Result | Evidence |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    blocked_ids: list[tuple[str, list[str]]] = []
    for family, gate, surface, risk, test, layers in UX_ROWS:
        if family == "UX-INPUT":
            gates = [entry.split("@", 1)[1] for entry in input_gates] or ["no-input"]
            for index, input_gate in enumerate(gates, start=1):
                identifier = f"UX-INPUT-GATE{index}" if len(gates) > 1 else "UX-INPUT"
                lines.append(f"| [{identifier}] {{gate={input_gate}}} | {surface} | {risk} | {{contract=ux-input-v1}} {test} | {layers_text(layers)} | BLOCKED | {evidence(layers)} |")
                blocked_ids.append((identifier, layers))
            continue
        token = "ux-" + family.removeprefix("UX-").lower() + "-v1"
        lines.append(f"| [{family}] {{gate={gate}}} | {surface} | {risk} | {{contract={token}}} {test} | {layers_text(layers)} | BLOCKED | {evidence(layers)} |")
        blocked_ids.append((family, layers))
    lines += [
        "",
        "## Per-capability matrix",
        "",
        "| Capability | Version/device/surface | API/component/event | Declaration/permission | Official source/sample | Positive path | Negative/fallback path | Lifecycle/cleanup | Evidence layer | Result | Evidence |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    rows = []
    for item in inventory["items"]:
        identifier, layers, row = capability_row(item, surfaces)
        rows.append((identifier, row))
        blocked_ids.append((identifier, layers))
    for _identifier, row in sorted(rows, key=lambda pair: pair[0]):
        lines.append(row)
    blocked_sorted = sorted(identifier for identifier, _ in blocked_ids)
    gates_sorted = sorted(f"{identifier}@{layer}" for identifier, layers in blocked_ids for layer in layers)
    lines += [
        "",
        "## Final release decision",
        "",
        "Final status: BLOCKED",
        "Release-ready: NO",
        f"Reason: FAIL=[none]; BLOCKED=[{','.join(blocked_sorted)}]",
        f"Required gates: {','.join(gates_sorted)}",
        "",
    ]
    output = REPO / "docs" / "aiui-audit.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"wrote {output.relative_to(REPO)} with {len(rows)} capability rows and {len(blocked_sorted)} blocked IDs")
    print(f"revision {inventory['projectRevision']}")


if __name__ == "__main__":
    main()
