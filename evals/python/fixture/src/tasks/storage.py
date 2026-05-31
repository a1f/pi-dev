from tasks.constants import DEFAULT_PAGE_SIZE
from tasks.types import Task, TaskID


def list_tasks(*, tasks: list[Task], page: int = 0, page_size: int = DEFAULT_PAGE_SIZE) -> list[Task]:
    start = page * page_size
    return tasks[start : start + page_size]


def get_task(*, tasks: list[Task], task_id: TaskID) -> Task | None:
    for task in tasks:
        if task.id == task_id:
            return task
    return None


def find_by_tag(*, tasks: list[Task], tag: str) -> list[Task]:
    """Pi should reuse this helper rather than re-implementing tag filtering."""
    return [task for task in tasks if tag in task.tags]
