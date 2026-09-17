from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "generate-mesh-tracking.py"
ML_REQUIREMENTS = ROOT / "backend" / "requirements-ml.txt"

# (import_name, pip_hint) — checked before loading the mesh script so staging
# fails once with an install command instead of one ModuleNotFoundError at a time.
_MESH_IMPORTS: tuple[tuple[str, str], ...] = (
    ("torch", "torch"),
    ("torchvision", "torchvision"),
    ("numpy", "numpy"),
    ("PIL", "Pillow"),
    ("scipy", "scipy"),
    ("transformers", "transformers"),
    ("einops", "einops"),
    ("einshape", "einshape"),
    ("tree", "dm-tree"),  # DeepMind package; do not pip install "tree"
)


def _missing_mesh_packages() -> list[str]:
    missing: list[str] = []
    for import_name, pip_name in _MESH_IMPORTS:
        try:
            __import__(import_name)
        except ModuleNotFoundError:
            missing.append(pip_name)
        except ImportError as exc:
            missing.append(f"{pip_name} (import error: {exc})")
    return missing


def require_mesh_deps() -> None:
    """Fail fast if the API interpreter is missing mesh-tracking packages."""
    missing = _missing_mesh_packages()
    if not missing:
        return
    exe = sys.executable
    raise RuntimeError(
        "Mesh tracking runs in-process inside the API, so ML packages must be "
        f"installed in this interpreter ({exe}). Missing: {', '.join(missing)}. "
        f"Install with: {exe} -m pip install -r {ML_REQUIREMENTS}"
    )


def default_mesh_device() -> str:
    """Pick torch device for mesh tracking.

    Uses MESH_DEVICE when set. Generic DEVICE in .env is ignored here — it is
  often set to cpu for unrelated scripts and would otherwise slow every mesh job.
    """
    explicit = os.environ.get("MESH_DEVICE")
    if explicit:
        return explicit
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def generate_mesh(env: dict[str, str]) -> None:
    """Run the existing mesh tracker in-process under backend job control."""

    require_mesh_deps()
    previous_env = os.environ.copy()
    previous_path = list(sys.path)
    os.environ.update(env)
    print(f"Mesh tracking device: {env.get('DEVICE', 'mps')}", flush=True)
    print(f"Mesh tracking interpreter: {sys.executable}", flush=True)
    try:
        spec = importlib.util.spec_from_file_location("backend_mesh_tracking_impl", SCRIPT)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load mesh tracking implementation: {SCRIPT}")
        module = importlib.util.module_from_spec(spec)
        sys.modules["backend_mesh_tracking_impl"] = module
        spec.loader.exec_module(module)
        run_main(module)
    finally:
        os.environ.clear()
        os.environ.update(previous_env)
        sys.path[:] = previous_path
        sys.modules.pop("backend_mesh_tracking_impl", None)


def run_main(module: ModuleType) -> None:
    try:
        module.main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise RuntimeError(str(exc)) from exc
