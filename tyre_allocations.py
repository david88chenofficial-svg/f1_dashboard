"""Weekend dry-tyre allocations for the tyre-performance lab.

OpenF1 reports the relative compound (SOFT/MEDIUM/HARD), but not the absolute
Pirelli construction. This reviewable catalogue supplies that second piece of
information for completed 2023-2025 weekends. Unknown seasons or circuits
deliberately return no mapping rather than inferring one.
"""

from __future__ import annotations


PIRELLI_ALLOCATION_SOURCES = {
    2023: [
        "https://press.pirelli.com/en/?h=1&t=2023+Tyre+Compound+Choices",
    ],
    2024: [
        "https://press.pirelli.com/no-surprises-for-the-compounds-for-spain-austria-and-great-britain/",
        "https://press.pirelli.com/these-are-the-tyres-for-the-americas/",
        "https://press.pirelli.com/a-soft-september-for-pirelli-in-f1-compounds-confirmed-for-monza-baku-and-singapore/",
    ],
    2025: [
        "https://press.pirelli.com/changes-and-status-quo-when-it-comes-to-compound-choices-for-the-rest-of-the-season0/",
    ],
}


def _allocation(hard: str, medium: str, soft: str) -> dict[str, str]:
    return {"HARD": hard, "MEDIUM": medium, "SOFT": soft}


# Keys follow OpenF1's circuit_short_name values. Aliases are normalised below.
TYRE_ALLOCATIONS: dict[int, dict[str, dict[str, str]]] = {
    2023: {
        "Sakhir": _allocation("C1", "C2", "C3"),
        "Jeddah": _allocation("C2", "C3", "C4"),
        "Melbourne": _allocation("C2", "C3", "C4"),
        "Baku": _allocation("C3", "C4", "C5"),
        "Miami": _allocation("C2", "C3", "C4"),
        "Monaco": _allocation("C3", "C4", "C5"),
        "Barcelona": _allocation("C1", "C2", "C3"),
        "Montreal": _allocation("C3", "C4", "C5"),
        "Spielberg": _allocation("C3", "C4", "C5"),
        "Silverstone": _allocation("C1", "C2", "C3"),
        "Hungaroring": _allocation("C3", "C4", "C5"),
        "Spa-Francorchamps": _allocation("C2", "C3", "C4"),
        "Zandvoort": _allocation("C1", "C2", "C3"),
        "Monza": _allocation("C3", "C4", "C5"),
        "Singapore": _allocation("C3", "C4", "C5"),
        "Suzuka": _allocation("C1", "C2", "C3"),
        "Lusail": _allocation("C1", "C2", "C3"),
        "Austin": _allocation("C2", "C3", "C4"),
        "Mexico City": _allocation("C3", "C4", "C5"),
        "Sao Paulo": _allocation("C2", "C3", "C4"),
        "Las Vegas": _allocation("C3", "C4", "C5"),
        "Yas Marina": _allocation("C3", "C4", "C5"),
    },
    2024: {
        "Sakhir": _allocation("C1", "C2", "C3"),
        "Jeddah": _allocation("C2", "C3", "C4"),
        "Melbourne": _allocation("C3", "C4", "C5"),
        "Suzuka": _allocation("C1", "C2", "C3"),
        "Shanghai": _allocation("C2", "C3", "C4"),
        "Miami": _allocation("C2", "C3", "C4"),
        "Imola": _allocation("C3", "C4", "C5"),
        "Monaco": _allocation("C3", "C4", "C5"),
        "Montreal": _allocation("C3", "C4", "C5"),
        "Barcelona": _allocation("C1", "C2", "C3"),
        "Spielberg": _allocation("C3", "C4", "C5"),
        "Silverstone": _allocation("C1", "C2", "C3"),
        "Hungaroring": _allocation("C3", "C4", "C5"),
        "Spa-Francorchamps": _allocation("C2", "C3", "C4"),
        "Zandvoort": _allocation("C1", "C2", "C3"),
        "Monza": _allocation("C3", "C4", "C5"),
        "Baku": _allocation("C3", "C4", "C5"),
        "Singapore": _allocation("C3", "C4", "C5"),
        "Austin": _allocation("C2", "C3", "C4"),
        "Mexico City": _allocation("C3", "C4", "C5"),
        "Sao Paulo": _allocation("C3", "C4", "C5"),
        "Las Vegas": _allocation("C3", "C4", "C5"),
        "Lusail": _allocation("C1", "C2", "C3"),
        "Yas Marina": _allocation("C3", "C4", "C5"),
    },
    2025: {
        "Melbourne": _allocation("C3", "C4", "C5"),
        "Shanghai": _allocation("C2", "C3", "C4"),
        "Suzuka": _allocation("C1", "C2", "C3"),
        "Sakhir": _allocation("C1", "C2", "C3"),
        "Jeddah": _allocation("C3", "C4", "C5"),
        "Miami": _allocation("C3", "C4", "C5"),
        "Imola": _allocation("C4", "C5", "C6"),
        "Monaco": _allocation("C4", "C5", "C6"),
        "Barcelona": _allocation("C1", "C2", "C3"),
        "Montreal": _allocation("C4", "C5", "C6"),
        "Spielberg": _allocation("C3", "C4", "C5"),
        "Silverstone": _allocation("C2", "C3", "C4"),
        "Spa-Francorchamps": _allocation("C1", "C3", "C4"),
        "Hungaroring": _allocation("C3", "C4", "C5"),
        "Zandvoort": _allocation("C2", "C3", "C4"),
        "Monza": _allocation("C3", "C4", "C5"),
        "Baku": _allocation("C4", "C5", "C6"),
        "Singapore": _allocation("C3", "C4", "C5"),
        "Austin": _allocation("C1", "C3", "C4"),
        "Mexico City": _allocation("C2", "C4", "C5"),
        "Sao Paulo": _allocation("C2", "C3", "C4"),
        "Las Vegas": _allocation("C3", "C4", "C5"),
        "Lusail": _allocation("C1", "C2", "C3"),
        "Yas Marina": _allocation("C3", "C4", "C5"),
    },
}


ALIASES = {
    "Budapest": "Hungaroring",
    "Spa": "Spa-Francorchamps",
    "São Paulo": "Sao Paulo",
}


def allocation_for(year: int | None, circuit: str | None) -> dict[str, str] | None:
    """Return a copy of a known dry allocation, or ``None`` if unavailable."""
    if year is None or not circuit:
        return None
    canonical = ALIASES.get(circuit, circuit)
    allocation = TYRE_ALLOCATIONS.get(int(year), {}).get(canonical)
    return dict(allocation) if allocation else None


def allocation_sources_for(year: int | None) -> list[str]:
    return list(PIRELLI_ALLOCATION_SOURCES.get(int(year), [])) if year else []


def construction_for(
    year: int | None, circuit: str | None, relative_compound: str | None
) -> str | None:
    allocation = allocation_for(year, circuit)
    return allocation.get((relative_compound or "").upper()) if allocation else None
