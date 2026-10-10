"""The Operations Research core, kept apart from the web application.

Everything in this folder is *only* modelling: variables, objective, constraints.
Nothing here reads the CSV, uses pandas, or knows FastAPI exists.  The only
third-party import allowed is `pulp` (enforced by `tests/test_or_models_pure.py`).

    inputs.py     the plain numbers each model needs
    lp_model.py   Part 1 - workforce and equipment allocation (LP / MILP)
    ip_model.py   Part 2 - shipment selection (0-1 integer programme)
"""
