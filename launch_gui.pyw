"""One-click, no-console launcher for the F1 dashboard."""

from __future__ import annotations

import sys

from launch_dashboard import main


def show_error(message: str) -> None:
    if sys.platform.startswith("win"):
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, "F1 Dashboard", 0x10)
    else:
        print(message, file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BaseException as exc:
        detail = str(exc) or type(exc).__name__
        show_error(f"The F1 Dashboard could not start.\n\n{detail}")
