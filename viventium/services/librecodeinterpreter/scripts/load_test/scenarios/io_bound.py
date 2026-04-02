"""I/O-bound test scenarios."""

from .base import BaseScenario


class IOWriteSmallScenario(BaseScenario):
    """Write many small files."""

    id = "io_small"
    name = "I/O Small Files"
    description = "Write 10 x 100KB files"
    category = "io"
    language = "py"
    expected_latency_range = (100, 2000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import os

# Create 10 x 100KB files
for i in range(10):
    content = 'x' * (100 * 1024)  # 100KB
    filename = f'/mnt/data/small_file_{{i}}_{iteration}.txt'
    with open(filename, 'w') as f:
        f.write(content)

files = os.listdir('/mnt/data')
total_size = sum(os.path.getsize(f'/mnt/data/{{f}}') for f in files if f.startswith('small_file'))
print(f'Iteration {iteration}: Created 10 files, total size={{total_size / 1024:.0f}}KB')
"""


class IOWriteLargeScenario(BaseScenario):
    """Write fewer large files."""

    id = "io_large"
    name = "I/O Large Files"
    description = "Write 3 x 1MB files"
    category = "io"
    language = "py"
    expected_latency_range = (200, 3000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import os

# Create 3 x 1MB files
for i in range(3):
    content = 'y' * (1024 * 1024)  # 1MB
    filename = f'/mnt/data/large_file_{{i}}_{iteration}.txt'
    with open(filename, 'w') as f:
        f.write(content)

files = os.listdir('/mnt/data')
total_size = sum(os.path.getsize(f'/mnt/data/{{f}}') for f in files if f.startswith('large_file'))
print(f'Iteration {iteration}: Created 3 files, total size={{total_size / (1024*1024):.1f}}MB')
"""


class IOMatplotlibScenario(BaseScenario):
    """Generate matplotlib plots."""

    id = "io_matplotlib"
    name = "I/O Matplotlib"
    description = "Generate PNG plot files"
    category = "io"
    language = "py"
    expected_latency_range = (300, 3000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

# Generate data
np.random.seed({iteration})
x = np.linspace(0, 10, 100)
y1 = np.sin(x) + np.random.normal(0, 0.1, 100)
y2 = np.cos(x) + np.random.normal(0, 0.1, 100)

# Create plot
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
ax1.plot(x, y1, 'b-', label='sin(x)')
ax1.fill_between(x, y1 - 0.2, y1 + 0.2, alpha=0.3)
ax1.legend()
ax1.set_title(f'Sine Wave (iter {iteration})')

ax2.scatter(x, y2, c=y2, cmap='viridis', s=20)
ax2.set_title(f'Cosine Scatter (iter {iteration})')

plt.tight_layout()
plt.savefig(f'/mnt/data/plot_{iteration}.png', dpi=100)
plt.close()

import os
size = os.path.getsize(f'/mnt/data/plot_{iteration}.png')
print(f'Iteration {iteration}: Created plot, size={{size / 1024:.1f}}KB')
"""


class IOCSVScenario(BaseScenario):
    """CSV read/write operations."""

    id = "io_csv"
    name = "I/O CSV"
    description = "CSV read, transform, write operations"
    category = "io"
    language = "py"
    expected_latency_range = (200, 2000)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import pandas as pd
import numpy as np
import os

# Generate data
np.random.seed({iteration})
n_rows = 50000
df = pd.DataFrame({{
    'id': range(n_rows),
    'value_a': np.random.rand(n_rows),
    'value_b': np.random.randint(0, 1000, n_rows),
    'category': np.random.choice(['A', 'B', 'C', 'D'], n_rows),
}})

# Write initial CSV
input_file = f'/mnt/data/input_{iteration}.csv'
df.to_csv(input_file, index=False)

# Read and transform
df_read = pd.read_csv(input_file)
df_read['value_sum'] = df_read['value_a'] + df_read['value_b']
df_read['category_upper'] = df_read['category'].str.upper()

# Write transformed CSV
output_file = f'/mnt/data/output_{iteration}.csv'
df_read.to_csv(output_file, index=False)

input_size = os.path.getsize(input_file)
output_size = os.path.getsize(output_file)
print(f'Iteration {iteration}: Input={{input_size/1024:.0f}}KB, Output={{output_size/1024:.0f}}KB')
"""


class IOJsonScenario(BaseScenario):
    """JSON read/write operations."""

    id = "io_json"
    name = "I/O JSON"
    description = "JSON read/write with nested data"
    category = "io"
    language = "py"
    expected_latency_range = (100, 1500)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import json
import os

# Generate nested data structure
data = {{
    'iteration': {iteration},
    'records': [
        {{
            'id': i,
            'name': f'Record {{i}}',
            'values': [j * 0.1 for j in range(100)],
            'metadata': {{
                'created': '2024-01-01',
                'version': i % 5,
            }}
        }}
        for i in range(1000)
    ]
}}

# Write JSON
filename = f'/mnt/data/data_{iteration}.json'
with open(filename, 'w') as f:
    json.dump(data, f)

# Read back and validate
with open(filename, 'r') as f:
    loaded = json.load(f)

size = os.path.getsize(filename)
print(f'Iteration {iteration}: Records={{len(loaded["records"])}}, Size={{size/1024:.0f}}KB')
"""


class IOImageProcessingScenario(BaseScenario):
    """Image processing with OpenCV."""

    id = "io_image"
    name = "I/O Image Processing"
    description = "Image creation and processing with OpenCV"
    category = "io"
    language = "py"
    expected_latency_range = (200, 2500)

    def get_code(self, iteration: int = 0) -> str:
        return f"""
import cv2
import numpy as np
import os

# Create synthetic image
np.random.seed({iteration})
height, width = 800, 1200
img = np.random.randint(0, 255, (height, width, 3), dtype=np.uint8)

# Apply some processing
img_blur = cv2.GaussianBlur(img, (15, 15), 0)
img_gray = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY)
edges = cv2.Canny(img_gray, 50, 150)

# Draw some shapes
cv2.rectangle(img_blur, (100, 100), (300, 300), (0, 255, 0), 3)
cv2.circle(img_blur, (600, 400), 100, (255, 0, 0), -1)

# Save outputs
cv2.imwrite(f'/mnt/data/processed_{iteration}.png', img_blur)
cv2.imwrite(f'/mnt/data/edges_{iteration}.png', edges)

size1 = os.path.getsize(f'/mnt/data/processed_{iteration}.png')
size2 = os.path.getsize(f'/mnt/data/edges_{iteration}.png')
print(f'Iteration {iteration}: Processed={{size1/1024:.0f}}KB, Edges={{size2/1024:.0f}}KB')
"""
