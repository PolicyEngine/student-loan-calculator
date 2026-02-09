"""Modal deployment for Student Loan Calculator API.

This module provides a serverless deployment of the student loan calculator
API using Modal.com infrastructure.

To deploy:
    modal deploy src/uk_budget_data/modal_app.py

To run locally:
    modal serve src/uk_budget_data/modal_app.py
"""

import modal
from pathlib import Path

app = modal.App("student-loan-calculator-api")

# Create image with all dependencies and local module copied in
image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "fastapi",
        "pydantic",
        "numpy",
        "pandas",
        "policyengine-uk==2.72.2",
    )
    .add_local_file(
        Path(__file__).parent / "student_loan_effective_ni.py",
        remote_path="/root/student_loan_effective_ni.py",
    )
)


@app.function(
    image=image,
    timeout=300,
    memory=2048,
)
@modal.concurrent(max_inputs=10)
@modal.asgi_app()
def fastapi_app():
    """Serve the FastAPI app via Modal."""
    import sys
    sys.path.insert(0, "/root")

    # Pre-warm PolicyEngine on container start (expensive first-time init)
    from student_loan_effective_ni import get_tax_parameters
    get_tax_parameters(2026)  # Warm the cache

    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from functools import lru_cache
    from typing import Optional

    import numpy as np
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field

    from student_loan_effective_ni import (
        get_tax_parameters,
        generate_lifetime_repayment_data,
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

    api = FastAPI(
        title="Student Loan Calculator API",
        description="Calculate student loan repayments and policy impacts",
        version="0.2.0",
    )

    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    class CalculatorInput(BaseModel):
        """API request model for calculator inputs."""
        starting_salary: float = Field(default=30000, ge=0)
        loan_amount: float = Field(default=45000, ge=0)
        plan: str = Field(default="plan2")
        salary_growth_rate: float = Field(default=0.03, ge=0, le=0.2)
        year: int = Field(default=2026, ge=2025, le=2030)
        has_postgrad: bool = Field(default=False)
        postgrad_balance: float = Field(default=0, ge=0)
        interest_rate: Optional[float] = Field(default=None, ge=0, le=0.2)

    class CompleteMTRInput(BaseModel):
        """API request model for complete marginal tax rate calculation."""
        year: int = Field(default=2026, ge=2025, le=2030)
        student_loan_plan: str = Field(default="PLAN_2")
        num_children: int = Field(default=0, ge=0, le=10)
        monthly_rent: float = Field(default=0, ge=0, le=5000)
        is_couple: bool = Field(default=False)
        partner_income: float = Field(default=0, ge=0, le=200000)
        has_postgrad: bool = Field(default=False)
        income_max: int = Field(default=150000, ge=20000, le=200000)
        exact_income: Optional[float] = Field(default=None, ge=0, le=200000)

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

    @api.get("/")
    async def root():
        return {"status": "ok", "service": "student-loan-calculator-api", "version": "0.2.0"}

    @api.get("/health")
    async def health_check():
        """Health check endpoint."""
        return {"status": "healthy"}

    @api.post("/calculate")
    async def calculate_student_loan(data: CalculatorInput):
        """Calculate student loan repayment projections."""
        try:
            calc_params = {
                "starting_salary": data.starting_salary,
                "loan_amount": data.loan_amount,
                "plan": data.plan,
                "salary_growth_rate": data.salary_growth_rate,
                "year": data.year,
                "interest_rate_override": data.interest_rate,
            }

            loop = asyncio.get_event_loop()
            lifetime_future = loop.run_in_executor(
                executor, lambda: generate_lifetime_repayment_data(**calc_params)
            )
            policy_future = loop.run_in_executor(
                executor, lambda: generate_policy_comparison_data(**calc_params)
            )

            # Conditionally run postgrad lifetime calculation
            postgrad_future = None
            if data.postgrad_balance > 0:
                postgrad_future = loop.run_in_executor(
                    executor, lambda: generate_lifetime_repayment_data(
                        starting_salary=data.starting_salary,
                        loan_amount=data.postgrad_balance,
                        plan="postgrad",
                        salary_growth_rate=data.salary_growth_rate,
                        year=data.year,
                    )
                )

            lifetime_df, policy_df = await asyncio.gather(
                lifetime_future, policy_future
            )

            postgrad_lifetime_df = None
            if postgrad_future:
                postgrad_lifetime_df = await postgrad_future

            lifetime_data = lifetime_df.to_dict(orient="records") if not lifetime_df.empty else []
            policy_data = policy_df.to_dict(orient="records") if not policy_df.empty else []
            postgrad_lifetime_data = (
                postgrad_lifetime_df.to_dict(orient="records")
                if postgrad_lifetime_df is not None and not postgrad_lifetime_df.empty
                else []
            )

            return convert_to_native({
                "lifetime_data": lifetime_data,
                "policy_data": policy_data,
                "postgrad_lifetime_data": postgrad_lifetime_data,
            })

        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Calculation error: {e}")

    @api.post("/complete-mtr")
    async def calculate_complete_mtr(data: CompleteMTRInput):
        """Calculate complete marginal tax rates including Universal Credit."""
        try:
            loop = asyncio.get_event_loop()

            plan_map = {
                "none": "NONE",
                "plan1": "PLAN_1",
                "plan2": "PLAN_2",
                "plan4": "PLAN_4",
                "plan5": "PLAN_5",
                "postgrad": "POSTGRADUATE",
                "NONE": "NONE",
                "PLAN_1": "PLAN_1",
                "PLAN_2": "PLAN_2",
                "PLAN_4": "PLAN_4",
                "PLAN_5": "PLAN_5",
                "POSTGRADUATE": "POSTGRADUATE",
            }
            student_loan_plan = plan_map.get(data.student_loan_plan, "PLAN_2")

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
                    num_points=81,  # Reduced from 161 for faster response
                    exact_income=data.exact_income,
                )
            )

            mtr_df = await mtr_future
            mtr_data = mtr_df.to_dict(orient="records") if not mtr_df.empty else []

            max_mtr = mtr_df["total_marginal_rate"].max() if not mtr_df.empty else 0
            max_mtr_income = mtr_df.loc[mtr_df["total_marginal_rate"].idxmax(), "employment_income"] if not mtr_df.empty else 0

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

    @api.get("/parameters/{year}")
    async def get_parameters(year: int = 2026):
        """Get tax parameters for a specific year."""
        try:
            params = get_cached_tax_parameters(year)
            return convert_to_native(params)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error fetching parameters: {e}")

    return api
