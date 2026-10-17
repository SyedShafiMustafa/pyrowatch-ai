"""Small per-process cache and concurrency bound; never a global quota guarantee."""
from collections import OrderedDict, deque
from datetime import datetime, timezone
from threading import Lock
from time import monotonic


class LiveFetchBusy(RuntimeError):
    pass


class LiveAreaCache:
    def __init__(self, ttl=300, capacity=8, requests_per_minute=6, clock=monotonic):
        self.ttl = ttl
        self.capacity = capacity
        self.requests_per_minute = requests_per_minute
        self.clock = clock
        self.entries = OrderedDict()
        self.requests = deque()
        self.lock = Lock()

    def fetch(self, key, loader):
        if not self.lock.acquire(blocking=False):
            raise LiveFetchBusy("Another live fetch is running; retry shortly")
        try:
            now = self.clock()
            entry = self.entries.get(key)
            if entry and now - entry[0] < self.ttl:
                self.entries.move_to_end(key)
                return entry[1], entry[2], True
            while self.requests and now - self.requests[0] >= 60:
                self.requests.popleft()
            if len(self.requests) >= self.requests_per_minute:
                raise LiveFetchBusy("Live fetch limit reached; retry in one minute")
            self.requests.append(now)
            text = loader()
            fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            self.entries[key] = (self.clock(), text, fetched_at)
            self.entries.move_to_end(key)
            while len(self.entries) > self.capacity:
                self.entries.popitem(last=False)
            return text, fetched_at, False
        finally:
            self.lock.release()
