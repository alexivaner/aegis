"""Framework-free meeting evidence, validation, and bounded cooperative scheduling."""

import re
from dataclasses import asdict, dataclass, field
from typing import Any
from uuid import uuid4


@dataclass(frozen=True)
class Sentence:
    id: str
    speaker: str
    text: str


def parse_notes(text: str) -> tuple[Sentence, ...]:
    if not 10 <= len(text) <= 6000:
        raise ValueError("Use 10–6000 characters of meeting notes")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not 1 <= len(lines) <= 20 or any(len(line) > 800 for line in lines):
        raise ValueError("Use up to 20 short lines, at most 800 characters per line")
    result = []
    for index, line in enumerate(lines):
        match = re.match(r"^([\w .'-]{1,40}):\s*(.+)$", line)
        speaker, body = (match.group(1).strip(), match.group(2).strip()) if match else ("Unspecified", line)
        result.append(Sentence(f"s{index + 1}", speaker, body))
    return tuple(result)


def validate_document(raw: dict[str, Any], sentences: tuple[Sentence, ...]) -> dict[str, Any]:
    """Verify structure and source quotations; references cannot prove semantic entailment."""
    if set(raw) != {"summary", "actions", "decisions"}:
        raise ValueError("Expected summary, actions and decisions only")
    if not isinstance(raw["summary"], list) or not raw["summary"]:
        raise ValueError("At least one source-linked key point is required")
    sources = {item.id: item for item in sentences}
    for category in ("summary", "actions", "decisions"):
        items = raw[category]
        if not isinstance(items, list) or len(items) > 12:
            raise ValueError("Too many output items")
        for item in items:
            keys = {"text", "source_ids", "evidence_quote"} | (
                {"owner", "due"} if category == "actions" else set()
            )
            if not isinstance(item, dict) or set(item) != keys:
                raise ValueError("Invalid output item")
            if not isinstance(item["text"], str) or not 1 <= len(item["text"]) <= 500:
                raise ValueError("Invalid output text")
            ids, quote = item["source_ids"], item["evidence_quote"]
            if (
                not isinstance(ids, list)
                or not 1 <= len(ids) <= 3
                or not all(isinstance(i, str) and i in sources for i in ids)
            ):
                raise ValueError("Unknown or missing source reference")
            if (
                not isinstance(quote, str)
                or not quote.strip()
                or not any(quote in sources[i].text for i in ids)
            ):
                raise ValueError("Evidence quote must occur in a referenced source")
            if category == "actions":
                for name in ("owner", "due"):
                    value = item[name]
                    if value is not None and (
                        not isinstance(value, str) or not value.strip() or len(value) > 120
                    ):
                        raise ValueError("Invalid owner or due date")
                    if value is not None and not any(
                        re.search(
                            r"(?<!\w)" + re.escape(value) + r"(?!\w)",
                            sources[i].speaker + " " + sources[i].text,
                            re.IGNORECASE,
                        )
                        for i in ids
                    ):
                        raise ValueError("Owner/due date is not supported by the source")
    return raw


@dataclass
class QueueItem:
    id: str
    kind: str
    label: str
    priority: int
    total: int
    done: int = 0
    waited: int = 0
    status: str = "queued"
    payload: dict[str, Any] = field(default_factory=dict, repr=False)
    result: dict[str, Any] | None = field(default=None, repr=False)

    def view(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if key not in {"payload", "result"}}


class CooperativeQueue:
    """One worker; chunks yield cooperatively. Aging counts work turns, not wall time."""

    def __init__(self) -> None:
        self.items: list[QueueItem] = []
        self.events: list[str] = []
        self.words: set[str] = set()
        self.last_kind: str | None = None

    def add(self, kind: str, label: str, payload: dict[str, Any] | None = None) -> QueueItem:
        if len(self.items) >= 12:
            terminal = next(
                (
                    item
                    for item in self.items
                    if item.status in {"complete", "cancelled", "failed", "blocked"}
                ),
                None,
            )
            if terminal:
                self.items.remove(terminal)
            else:
                raise ValueError("Queue is full")
        item = QueueItem(
            str(uuid4()),
            kind,
            label,
            0 if kind == "meeting" else 10,
            1 if kind == "meeting" else 4,
            payload=payload or {},
        )
        self.items.append(item)
        self.log(f"Added {label} to the work queue.")
        return item

    def log(self, message: str) -> None:
        self.events = [*self.events[-11:], message]

    def next(self) -> QueueItem | None:
        waiting = [item for item in self.items if item.status in {"queued", "paused"}]
        if not waiting:
            return None
        chosen = min(waiting, key=lambda item: item.priority - 2 * item.waited)
        if chosen.kind == "meeting" and any(item.kind == "background" for item in waiting):
            self.log("Meeting request takes priority. Background indexing yields at a chunk boundary.")
        if chosen.kind == "background" and any(item.kind == "meeting" for item in waiting):
            self.log("Aging gives the waiting background task one turn so it cannot wait forever.")
        for item in waiting:
            if item is not chosen:
                item.waited += 1
                item.status = "paused"
        chosen.waited, chosen.status = 0, "running"
        self.last_kind = chosen.kind
        return chosen

    def snapshot(self) -> dict[str, Any]:
        pending = sorted(
            (item for item in self.items if item.status in {"queued", "paused"}),
            key=lambda item: item.priority - 2 * item.waited,
        )
        return {
            "items": [item.view() for item in self.items],
            "next_order": [item.id for item in pending],
            "events": self.events,
            "indexed_words": len(self.words),
            "scope": "One Python worker, cooperative chunks, turn-based aging; no hardware preemption or deadline guarantee",
        }
