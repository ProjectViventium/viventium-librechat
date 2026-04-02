"""Memory-bound test scenarios."""

from .base import BaseScenario


class Memory10MBScenario(BaseScenario):
    """Allocate 10MB of memory."""

    id = "mem_10mb"
    name = "Memory 10MB"
    description = "Allocate 10MB NumPy array"
    category = "memory"
    language = "py"
    expected_latency_range = (50, 500)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import numpy as np
# 10MB = 10 * 1024 * 1024 bytes / 8 bytes per float64 = 1,310,720 elements
size = 1310720
arr = np.random.rand(size)
print(f'Iteration {iteration}: Allocated 10MB, sum={{arr.sum():.4f}}')
"""


class Memory50MBScenario(BaseScenario):
    """Allocate 50MB of memory."""

    id = "mem_50mb"
    name = "Memory 50MB"
    description = "Allocate 50MB NumPy array"
    category = "memory"
    language = "py"
    expected_latency_range = (100, 1000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import numpy as np
# 50MB = 6,553,600 float64 elements
size = 6553600
arr = np.random.rand(size)
print(f'Iteration {iteration}: Allocated 50MB, mean={{arr.mean():.6f}}')
"""


class Memory100MBScenario(BaseScenario):
    """Allocate 100MB of memory."""

    id = "mem_100mb"
    name = "Memory 100MB"
    description = "Allocate 100MB NumPy array"
    category = "memory"
    language = "py"
    expected_latency_range = (200, 2000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import numpy as np
# 100MB = 13,107,200 float64 elements
size = 13107200
arr = np.random.rand(size)
print(f'Iteration {iteration}: Allocated 100MB, std={{arr.std():.6f}}')
"""


class MemoryPandasScenario(BaseScenario):
    """Large Pandas DataFrame operations."""

    id = "mem_pandas"
    name = "Memory Pandas"
    description = "1M row DataFrame operations"
    category = "memory"
    language = "py"
    expected_latency_range = (300, 3000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import pandas as pd
import numpy as np

np.random.seed({iteration})
n_rows = 1000000
df = pd.DataFrame({{
    'a': np.random.rand(n_rows),
    'b': np.random.rand(n_rows),
    'c': np.random.randint(0, 100, n_rows),
    'd': np.random.choice(['x', 'y', 'z'], n_rows),
}})

# Perform operations
grouped = df.groupby('d').agg({{'a': 'mean', 'b': 'sum', 'c': 'max'}})
print(f'Iteration {iteration}: DataFrame shape={{df.shape}}, memory={{df.memory_usage(deep=True).sum() / 1e6:.1f}}MB')
print(grouped)
"""


class MemoryListScenario(BaseScenario):
    """Large Python list operations."""

    id = "mem_list"
    name = "Memory List"
    description = "Large Python list allocation and operations"
    category = "memory"
    language = "py"
    expected_latency_range = (100, 1000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import sys
# Create a large list of integers
size = 5000000
data = list(range(size))
# Perform operations
total = sum(data)
filtered = [x for x in data if x % 2 == 0]
mem_mb = sys.getsizeof(data) / (1024 * 1024)
print(f'Iteration {iteration}: List size={{size}}, sum={{total}}, even_count={{len(filtered)}}, mem~{{mem_mb:.1f}}MB')
"""


class MemoryDictScenario(BaseScenario):
    """Large dictionary operations."""

    id = "mem_dict"
    name = "Memory Dict"
    description = "Large dictionary allocation and operations"
    category = "memory"
    language = "py"
    expected_latency_range = (100, 1500)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import sys
# Create a large dictionary
size = 1000000
data = {{i: f'value_{{i}}_{iteration}' for i in range(size)}}
# Perform operations
keys = list(data.keys())
values = list(data.values())
mem_mb = sys.getsizeof(data) / (1024 * 1024)
print(f'Iteration {iteration}: Dict size={{len(data)}}, first_key={{keys[0]}}, mem~{{mem_mb:.1f}}MB')
"""
