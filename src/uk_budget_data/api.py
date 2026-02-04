"""FastAPI backend for student loan calculator.

This module provides a REST API endpoint for calculating student loan
repayments, interest impact, and policy scenarios.
"""

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .student_loan_effective_ni import (
    get_tax_parameters,
    generate_lifetime_repayment_data,
    generate_interest_comparison_data,
    generate_policy_comparison_data,
    calculate_complete_marginal_rates,
)

# Thread pool for running CPU-bound calculations in parallel
executor = ThreadPoolExecutor(max_workers=3)


# Cache tax parameters (they don't change during runtime)
@lru_cache(maxsize=10)
def get_cached_tax_parameters(year: int):
    """Get tax parameters with caching."""
    return get_tax_parameters(year)

app = FastAPI(
    title="Student Loan Calculator API",
    description="Calculate student loan repayments and policy impacts",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CalculatorInput(BaseModel):
    """API request model for calculator inputs."""

    starting_salary: float = Field(
        default=30000, ge=0, description="Starting annual salary (GBP)"
    )
    loan_amount: float = Field(
        default=45000, ge=0, description="Initial loan balance (GBP)"
    )
    plan: str = Field(
        default="plan2",
        description="Student loan plan (plan1, plan2, plan4, plan5)",
    )
    salary_growth_rate: float = Field(
        default=0.03,
        ge=0,
        le=0.2,
        description="Annual salary growth rate (e.g., 0.03 for 3%)",
    )
    year: int = Field(
        default=2026,
        ge=2025,
        le=2030,
        description="Tax year for parameters",
    )
    has_postgrad: bool = Field(
        default=False,
        description="Whether borrower has postgraduate loan",
    )
    interest_rate: Optional[float] = Field(
        default=None,
        ge=0,
        le=0.2,
        description="Custom interest rate override (e.g., 0.06 for 6%). If None, uses plan default.",
    )


class CompleteMTRInput(BaseModel):
    """API request model for complete marginal tax rate calculation including UC."""

    year: int = Field(
        default=2026,
        ge=2025,
        le=2030,
        description="Tax year for parameters",
    )
    student_loan_plan: str = Field(
        default="PLAN_2",
        description="Student loan plan (NONE, PLAN_1, PLAN_2, PLAN_4, PLAN_5, POSTGRADUATE)",
    )
    num_children: int = Field(
        default=0,
        ge=0,
        le=10,
        description="Number of dependent children (affects UC eligibility and work allowance)",
    )
    monthly_rent: float = Field(
        default=0,
        ge=0,
        le=5000,
        description="Monthly rent amount (affects UC housing element)",
    )
    is_couple: bool = Field(
        default=False,
        description="Whether the claimant has a partner (affects UC standard allowance and income assessment)",
    )
    partner_income: float = Field(
        default=0,
        ge=0,
        le=200000,
        description="Partner's annual employment income (if couple)",
    )
    has_postgrad: bool = Field(
        default=False,
        description="Whether borrower has postgraduate loan (6% above threshold)",
    )
    income_max: int = Field(
        default=150000,
        ge=20000,
        le=200000,
        description="Maximum income for analysis range",
    )


def convert_to_native(obj):
    """Convert numpy types to Python native types for JSON serialisation."""
    if isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {k: convert_to_native(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_to_native(item) for item in obj]
    return obj


@app.post("/calculate")
async def calculate_student_loan(data: CalculatorInput):
    """Calculate student loan repayment projections.

    Returns:
        - lifetime_data: Year-by-year repayment projections
        - interest_data: Balance comparison with/without interest
        - policy_data: Frozen vs inflation-linked threshold comparison
        - summary: Key statistics
    """
    try:
        # Get tax parameters for the specified year (cached)
        params = get_cached_tax_parameters(data.year)

        # Common parameters for all calculations
        calc_params = {
            "starting_salary": data.starting_salary,
            "loan_amount": data.loan_amount,
            "plan": data.plan,
            "salary_growth_rate": data.salary_growth_rate,
            "year": data.year,
            "interest_rate_override": data.interest_rate,
        }

        # Run all three calculations in parallel using thread pool
        loop = asyncio.get_event_loop()
        lifetime_future = loop.run_in_executor(
            executor, lambda: generate_lifetime_repayment_data(**calc_params)
        )
        interest_future = loop.run_in_executor(
            executor, lambda: generate_interest_comparison_data(**calc_params)
        )
        policy_future = loop.run_in_executor(
            executor, lambda: generate_policy_comparison_data(**calc_params)
        )

        # Wait for all calculations to complete
        lifetime_df, interest_df, policy_df = await asyncio.gather(
            lifetime_future, interest_future, policy_future
        )

        # Convert DataFrames to list of dicts
        lifetime_data = lifetime_df.to_dict(orient="records") if not lifetime_df.empty else []
        interest_data = interest_df.to_dict(orient="records") if not interest_df.empty else []
        policy_data = policy_df.to_dict(orient="records") if not policy_df.empty else []

        # Calculate summary statistics from the data
        final_lifetime = lifetime_data[-1] if lifetime_data else {}
        final_interest = interest_data[-1] if interest_data else {}
        final_policy = policy_data[-1] if policy_data else {}

        # Get plan-specific threshold and interest rate
        plan_thresholds = {
            "plan1": params["sl_plan1_threshold"],
            "plan2": params["sl_plan2_threshold"],
            "plan4": params["sl_plan4_threshold"],
            "plan5": params["sl_plan5_threshold"],
        }
        plan_interest = {
            "plan1": params["sl_plan1_interest"],
            "plan2": (params["sl_plan2_interest_min"] + params["sl_plan2_interest_max"]) / 2,
            "plan4": params["sl_plan4_interest"],
            "plan5": params["sl_plan5_interest"],
        }

        summary = {
            "total_repaid": final_lifetime.get("total_repaid", 0),
            "written_off": final_lifetime.get("written_off", 0),
            "years_to_repay": final_lifetime.get("year", 0),
            "original_loan": data.loan_amount,
            "total_interest": final_interest.get("total_interest_paid", 0),
            "interest_rate": plan_interest.get(data.plan, 0.06),
            "extra_from_freeze": final_policy.get("difference", 0),
            "threshold": plan_thresholds.get(data.plan, 0),
            "threshold_if_linked": final_policy.get("threshold_growing", 0),
        }

        return convert_to_native({
            "lifetime_data": lifetime_data,
            "interest_data": interest_data,
            "policy_data": policy_data,
            "summary": summary,
        })

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calculation error: {e}")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.post("/complete-mtr")
async def calculate_complete_mtr(data: CompleteMTRInput):
    """Calculate complete marginal tax rates including Universal Credit.

    This endpoint calculates the true marginal deduction rate including:
    - Income tax
    - National Insurance
    - Student loan repayments
    - Universal Credit taper (55% withdrawal rate)

    For UC recipients with children and/or housing costs, marginal rates can
    reach 80%+ due to the UC taper interacting with income tax and NI.

    Returns:
        - mtr_data: Array of income levels with marginal rate breakdowns
        - summary: Key statistics about the MTR schedule
    """
    try:
        loop = asyncio.get_event_loop()

        # Map frontend plan names to PolicyEngine format
        plan_map = {
            "none": "NONE",
            "plan1": "PLAN_1",
            "plan2": "PLAN_2",
            "plan4": "PLAN_4",
            "plan5": "PLAN_5",
            "postgrad": "POSTGRADUATE",
            # Also accept uppercase versions
            "NONE": "NONE",
            "PLAN_1": "PLAN_1",
            "PLAN_2": "PLAN_2",
            "PLAN_4": "PLAN_4",
            "PLAN_5": "PLAN_5",
            "POSTGRADUATE": "POSTGRADUATE",
        }
        student_loan_plan = plan_map.get(data.student_loan_plan, "PLAN_2")

        # Run calculation in thread pool
        mtr_future = loop.run_in_executor(
            executor,
            lambda: calculate_complete_marginal_rates(
                year=data.year,
                student_loan_plan=student_loan_plan,
                num_children=data.num_children,
                monthly_rent=data.monthly_rent,
                is_couple=data.is_couple,
                partner_income=data.partner_income,
                has_postgrad=data.has_postgrad,
                income_range=(0, data.income_max),
                num_points=161,
            )
        )

        mtr_df = await mtr_future

        # Convert DataFrame to list of dicts
        mtr_data = mtr_df.to_dict(orient="records") if not mtr_df.empty else []

        # Calculate summary statistics
        max_mtr = mtr_df["total_marginal_rate"].max() if not mtr_df.empty else 0
        max_mtr_income = mtr_df.loc[mtr_df["total_marginal_rate"].idxmax(), "employment_income"] if not mtr_df.empty else 0

        # Find income ranges where UC taper applies (uc_marginal_rate > 0)
        uc_active = mtr_df[mtr_df["uc_marginal_rate"] > 0.01]
        uc_starts = uc_active["employment_income"].min() if not uc_active.empty else None
        uc_ends = uc_active["employment_income"].max() if not uc_active.empty else None

        summary = {
            "max_marginal_rate": float(max_mtr),
            "max_marginal_rate_income": float(max_mtr_income),
            "uc_taper_starts": float(uc_starts) if uc_starts else None,
            "uc_taper_ends": float(uc_ends) if uc_ends else None,
            "has_uc_taper": not uc_active.empty,
            "num_children": data.num_children,
            "monthly_rent": data.monthly_rent,
            "is_couple": data.is_couple,
            "partner_income": data.partner_income,
            "student_loan_plan": student_loan_plan,
        }

        return convert_to_native({
            "mtr_data": mtr_data,
            "summary": summary,
        })

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calculation error: {e}")


@app.get("/parameters/{year}")
async def get_parameters(year: int = 2026):
    """Get tax parameters for a specific year."""
    try:
        params = get_cached_tax_parameters(year)
        return convert_to_native(params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching parameters: {e}")


def main():
    """Run the FastAPI server with uvicorn."""
    import uvicorn

    port = int(os.environ.get("PORT", 5002))
    print(f"Starting Student Loan Calculator API on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
