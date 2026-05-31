from dataclasses import dataclass
from datetime import date


type TaskID = int


@dataclass(frozen=True)
class Task:
    id: TaskID
    title: str
    tags: tuple[str, ...]
    due: date | None = None
    done: bool = False


@dataclass(frozen=True)
class Project:
    name: str
    tasks: tuple[Task, ...]
