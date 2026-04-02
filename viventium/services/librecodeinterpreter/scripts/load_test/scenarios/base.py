"""Base scenario class for load testing."""

from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Tuple, Any


class BaseScenario(ABC):
    """Base class for all test scenarios."""

    # Subclasses must define these
    id: str = ""
    name: str = ""
    description: str = ""
    category: str = ""  # "cpu", "memory", "io", "language"
    language: str = "py"

    # Expected latency range (min_ms, max_ms)
    expected_latency_range: Tuple[int, int] = (20, 5000)

    @abstractmethod
    def get_code(self, iteration: int = 0) -> str:
        """Generate code for this scenario.

        Args:
            iteration: Iteration number, useful for varying code.

        Returns:
            Code string to execute.
        """
        pass

    def get_files(self) -> Optional[List[Dict[str, Any]]]:
        """Optional files to upload for this scenario.

        Returns:
            List of file dicts with 'name' and 'content' keys, or None.
        """
        return None

    def validate_result(self, success: bool, latency_ms: float) -> bool:
        """Validate execution result.

        Args:
            success: Whether execution succeeded.
            latency_ms: Execution latency in milliseconds.

        Returns:
            True if result is valid.
        """
        if not success:
            return False
        min_lat, max_lat = self.expected_latency_range
        return latency_ms <= max_lat * 2  # Allow some headroom

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(id={self.id}, category={self.category})"
