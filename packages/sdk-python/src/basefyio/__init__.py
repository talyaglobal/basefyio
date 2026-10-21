"""basefyio Python client.

::

    import basefyio

    bf = basefyio.create_client(url, key, project_id)
    rows = bf.from_("todos").select("*").execute().data
"""

from ._errors import BasefyioError
from .auth import AuthClient, Session
from .client import BasefyioClient, create_client
from .query import BasefyioResponse, QueryBuilder
from .storage import StorageBucketApi, StorageClient

__version__ = "0.1.0"

__all__ = [
    "AuthClient",
    "BasefyioClient",
    "BasefyioError",
    "BasefyioResponse",
    "QueryBuilder",
    "Session",
    "StorageBucketApi",
    "StorageClient",
    "create_client",
    "__version__",
]
