"""FastAPI entry point: routing and static mounting only."""

from __future__ import annotations

from pathlib import Path

import pulp
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.api import datasets, lp
from backend.core import config
from backend.core.store import store
from backend.schemas.common import HealthOut

app = FastAPI(
    title="Air Cargo Resource Allocation & Operational Optimization",
    description=(
        "Operations Research decision-support system for air-cargo terminals. "
        "Part 1 allocates workforce and equipment across terminals (LP); "
        "Part 2 selects which shipments to process under capacity limits (IP)."
    ),
    version="0.1.0",
)

app.include_router(datasets.router)
app.include_router(lp.router)


@app.get("/api/health", response_model=HealthOut)
def health() -> HealthOut:
    solver = pulp.PULP_CBC_CMD(msg=False)
    return HealthOut(
        status="ok",
        solver_available=bool(solver.available()),
        solver_name=solver.name,
        datasets_loaded=len(store.list_all()),
    )


_frontend = Path(config.PROJECT_ROOT) / "frontend"
if _frontend.is_dir():
    app.mount("/", StaticFiles(directory=_frontend, html=True), name="frontend")
