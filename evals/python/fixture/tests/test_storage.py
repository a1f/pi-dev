from datetime import date

from tasks.storage import find_by_tag, get_task, list_tasks
from tasks.types import Task


def _sample_tasks() -> list[Task]:
    return [
        Task(id=1, title="write spec", tags=("docs", "urgent"), due=date(2026, 6, 1)),
        Task(id=2, title="deploy app", tags=("ops",)),
        Task(id=3, title="docs review", tags=("docs",), done=True),
    ]


def test_list_tasks_paginates() -> None:
    tasks = _sample_tasks()
    assert list_tasks(tasks=tasks, page=0, page_size=2) == tasks[:2]
    assert list_tasks(tasks=tasks, page=1, page_size=2) == tasks[2:]


def test_get_task_returns_match() -> None:
    tasks = _sample_tasks()
    assert get_task(tasks=tasks, task_id=2) == tasks[1]


def test_get_task_returns_none_for_missing() -> None:
    tasks = _sample_tasks()
    assert get_task(tasks=tasks, task_id=999) is None


def test_find_by_tag_filters() -> None:
    tasks = _sample_tasks()
    docs_tasks = find_by_tag(tasks=tasks, tag="docs")
    assert {task.id for task in docs_tasks} == {1, 3}
