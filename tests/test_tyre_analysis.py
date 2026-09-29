import math
import unittest

import numpy as np

from plot_tyre_performance import (
    find_stint,
    fit_axis_aligned_envelope,
    representative_lap_cutoff,
)
from tyre_allocations import allocation_for, construction_for


class TyreAnalysisTests(unittest.TestCase):
    def test_axis_aligned_envelope_recovers_synthetic_shape(self):
        rng = np.random.default_rng(19)
        angles = rng.uniform(0, 2 * math.pi, 1200)
        radii = np.sqrt(rng.uniform(0, 1, 1200))
        lateral_axis = 40.0
        longitudinal_axis = 24.0
        points = [
            {
                "lateral_mps2": lateral_axis * radius * math.cos(angle),
                "longitudinal_mps2": longitudinal_axis * radius * math.sin(angle),
            }
            for radius, angle in zip(radii, angles)
        ]
        points.extend(
            {"lateral_mps2": 90.0, "longitudinal_mps2": 75.0}
            for _ in range(12)
        )

        fit = fit_axis_aligned_envelope(points, coverage=0.95)

        self.assertGreaterEqual(fit["coverage"], 0.95)
        self.assertAlmostEqual(fit["lateral_axis_mps2"], lateral_axis, delta=4.5)
        self.assertAlmostEqual(
            fit["longitudinal_axis_mps2"], longitudinal_axis, delta=3.0
        )
        self.assertEqual(fit["sample_count"], len(points))

    def test_too_few_samples_are_rejected(self):
        with self.assertRaises(ValueError):
            fit_axis_aligned_envelope(
                [{"lateral_mps2": 1.0, "longitudinal_mps2": 1.0}] * 10
            )

    def test_overlapping_stint_boundary_belongs_to_new_stint(self):
        stints = [
            {"stint_number": 1, "lap_start": 1, "lap_end": 10},
            {"stint_number": 2, "lap_start": 10, "lap_end": 16},
        ]

        self.assertEqual(find_stint(10, stints)["stint_number"], 2)

    def test_slow_lap_cutoff_separates_cooldown_lap(self):
        laps = [
            {"lap_number": 1, "lap_duration": 99.0, "is_pit_out_lap": False},
            {"lap_number": 2, "lap_duration": 95.0, "is_pit_out_lap": False},
            {"lap_number": 3, "lap_duration": 96.0, "is_pit_out_lap": False},
            {"lap_number": 4, "lap_duration": 142.0, "is_pit_out_lap": False},
            {"lap_number": 5, "lap_duration": 500.0, "is_pit_out_lap": True},
        ]

        cutoff = representative_lap_cutoff(laps, set(), True)

        self.assertGreater(cutoff, 96.0)
        self.assertLess(cutoff, 142.0)

    def test_weekend_allocation_maps_relative_to_absolute_compounds(self):
        self.assertEqual(
            allocation_for(2024, "Sakhir"),
            {"HARD": "C1", "MEDIUM": "C2", "SOFT": "C3"},
        )
        self.assertEqual(construction_for(2024, "Melbourne", "SOFT"), "C5")

    def test_non_consecutive_2025_allocation_is_preserved(self):
        self.assertEqual(
            allocation_for(2025, "Austin"),
            {"HARD": "C1", "MEDIUM": "C3", "SOFT": "C4"},
        )

    def test_unknown_allocation_is_not_guessed(self):
        self.assertIsNone(allocation_for(2026, "Sakhir"))
        self.assertIsNone(construction_for(2026, "Sakhir", "SOFT"))


if __name__ == "__main__":
    unittest.main()
