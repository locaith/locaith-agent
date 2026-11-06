"""Cho phép `python -m locaith_cli …` như `locaith …`."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
