import sys

from tasks.search import search
from tasks.storage import list_tasks
from tasks.types import Task


def main(*, argv: list[str], tasks: list[Task]) -> int:
    if len(argv) < 2:
        print("usage: tasks <list|search> [args]", file=sys.stderr)
        return 2

    command = argv[1]
    if command == "list":
        for task in list_tasks(tasks=tasks):
            print(f"{task.id}\t{task.title}")
        return 0

    if command == "search":
        if len(argv) < 3:
            print("usage: tasks search <query>", file=sys.stderr)
            return 2
        matches, total = search(tasks=tasks, query=argv[2])
        for task in matches:
            print(f"{task.id}\t{task.title}")
        print(f"{total} match(es)")
        return 0

    print(f"unknown command: {command}", file=sys.stderr)
    return 2
