"""dashgps - extract GPS tracks from dashcam video files.

MIT licensed. See NOTICE.md for how each format was derived and why no GPL code is present.
"""

__version__ = "0.1.0"

from . import formats as _formats  # noqa: F401  (registers the format table on import)
from .group import group_results  # noqa: F401
from .io import BytesReader, CountingReader, FileReader  # noqa: F401
from .model import NoFormatMatch, ParseError, ParseOptions, ParseResult, Point  # noqa: F401
from .postprocess import PostOptions, postprocess  # noqa: F401
from .registry import formats, parse_auto, sniff_all  # noqa: F401
