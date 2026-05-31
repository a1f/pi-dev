from tasks.types import Task


def search(*, tasks: list[Task], query: str) -> tuple[list[Task], int]:
    """Returns a bare tuple — refactor target for one of the eval cases."""
    matches = [t for t in tasks if query.lower() in t.title.lower()]
    return matches, len(matches)
