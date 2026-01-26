"""Student loan as effective NI: marginal deduction rates by age cohort.

This module models how Plan 2 student loan repayments function as a de facto
additional tax for younger workers, showing true marginal deduction rates
(income tax + NI + student loan) by age cohort.

Key insight: Workers born after ~1994 (started university 2012+) face a 9%
student loan repayment on income above the threshold, effectively creating
a generational tax disparity:
- Basic rate taxpayer without loan: 20% IT + 8% NI = 28%
- Basic rate taxpayer with Plan 2: 20% IT + 8% NI + 9% SL = 37%
- Higher rate taxpayer without loan: 40% IT + 2% NI = 42%
- Higher rate taxpayer with Plan 2: 40% IT + 2% NI + 9% SL = 51%

All rates are read directly from PolicyEngine UK parameters.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from policyengine_uk import CountryTaxBenefitSystem, Simulation


def get_tax_parameters(year: int = 2026) -> dict:
    """Load all relevant tax parameters from PolicyEngine UK.

    Args:
        year: Tax year for parameter lookup.

    Returns:
        Dict with all tax/NI/student loan parameters.
    """
    tbs = CountryTaxBenefitSystem()
    params = tbs.parameters
    date = f"{year}-01-01"

    # Income tax parameters
    it = params.gov.hmrc.income_tax
    pa_amount = it.allowances.personal_allowance.amount(date)

    # Tax bands (thresholds are cumulative in PE)
    basic_rate = it.rates.uk[0].rate(date)
    higher_rate = it.rates.uk[1].rate(date)
    additional_rate = it.rates.uk[2].rate(date)
    basic_band = it.rates.uk[0].threshold(date)  # Band width, not threshold
    higher_band = it.rates.uk[1].threshold(date)
    additional_threshold = it.rates.uk[2].threshold(date)

    # Calculate actual thresholds
    basic_rate_threshold = pa_amount + basic_band + higher_band
    higher_rate_threshold = additional_threshold

    # Personal allowance taper (PA reduced by £1 for every £2 above threshold)
    pa_taper_threshold = it.allowances.personal_allowance.maximum_ANI(date)
    pa_taper_rate = it.allowances.personal_allowance.reduction_rate(date)

    # National Insurance parameters
    ni = params.gov.hmrc.national_insurance.class_1
    # NI thresholds are weekly, convert to annual
    ni_primary_threshold = ni.thresholds.primary_threshold(date) * 52
    ni_uel = ni.thresholds.upper_earnings_limit(date) * 52
    ni_main_rate = ni.rates.employee.main(date)
    ni_higher_rate = ni.rates.employee.additional(date)

    # Student loan parameters
    sl = params.gov.hmrc.student_loans
    sl_repayment_rate = sl.repayment_rate(date)
    sl_plan2_threshold = sl.thresholds.plan_2(date)
    sl_plan1_threshold = sl.thresholds.plan_1(date)
    sl_plan4_threshold = sl.thresholds.plan_4(date)
    sl_plan5_threshold = sl.thresholds.plan_5(date)
    sl_postgrad_threshold = sl.thresholds.postgraduate(date)
    sl_postgrad_rate = sl.postgraduate_repayment_rate(date)

    return {
        # Income tax
        "personal_allowance": pa_amount,
        "basic_rate": basic_rate,
        "higher_rate": higher_rate,
        "additional_rate": additional_rate,
        "basic_rate_threshold": basic_rate_threshold,
        "higher_rate_threshold": higher_rate_threshold,
        "pa_taper_threshold": pa_taper_threshold,
        "pa_taper_rate": pa_taper_rate,
        # National Insurance
        "ni_primary_threshold": ni_primary_threshold,
        "ni_upper_earnings_limit": ni_uel,
        "ni_main_rate": ni_main_rate,
        "ni_higher_rate": ni_higher_rate,
        # Student loans
        "sl_repayment_rate": sl_repayment_rate,
        "sl_plan2_threshold": sl_plan2_threshold,
        "sl_plan1_threshold": sl_plan1_threshold,
        "sl_plan4_threshold": sl_plan4_threshold,
        "sl_plan5_threshold": sl_plan5_threshold,
        "sl_postgrad_threshold": sl_postgrad_threshold,
        "sl_postgrad_rate": sl_postgrad_rate,
    }


@dataclass
class AgeCohort:
    """Represents an age cohort with their student loan status."""

    name: str
    age: int
    has_plan2_loan: bool
    description: str


# Age cohorts for comparison
AGE_COHORTS = [
    AgeCohort(
        name="Under 30 (Plan 2)",
        age=28,
        has_plan2_loan=True,
        description="Started university 2015+, has Plan 2 student loan",
    ),
    AgeCohort(
        name="30-35 (Plan 2)",
        age=32,
        has_plan2_loan=True,
        description="Started university 2012-2014, has Plan 2 student loan",
    ),
    AgeCohort(
        name="40+ (No loan)",
        age=45,
        has_plan2_loan=False,
        description="Pre-2012 university or no student loan",
    ),
    AgeCohort(
        name="50+ (No loan)",
        age=55,
        has_plan2_loan=False,
        description="Pre-2012 university or no student loan",
    ),
]


def calculate_marginal_rate(
    gross_income: float,
    params: dict,
    has_student_loan: bool = False,
) -> dict:
    """Calculate marginal deduction rate using PE UK parameters.

    Args:
        gross_income: Annual gross employment income.
        params: Tax parameters from get_tax_parameters().
        has_student_loan: Whether the person has a Plan 2 student loan.

    Returns:
        Dict with breakdown of marginal rates.
    """
    # Determine income tax marginal rate
    if gross_income <= params["personal_allowance"]:
        it_rate = 0.0
    elif gross_income <= params["basic_rate_threshold"]:
        it_rate = params["basic_rate"]
    elif gross_income <= params["higher_rate_threshold"]:
        it_rate = params["higher_rate"]
    else:
        it_rate = params["additional_rate"]

    # Personal allowance taper adds effective 60% rate
    if (
        params["pa_taper_threshold"]
        < gross_income
        <= params["higher_rate_threshold"]
    ):
        # 40% + (20% from PA taper at 50% withdrawal rate)
        it_rate = params["higher_rate"] + (
            params["basic_rate"] * params["pa_taper_rate"]
        )

    # Determine NI marginal rate
    if gross_income <= params["ni_primary_threshold"]:
        ni_rate = 0.0
    elif gross_income <= params["ni_upper_earnings_limit"]:
        ni_rate = params["ni_main_rate"]
    else:
        ni_rate = params["ni_higher_rate"]

    # Student loan marginal rate (9% above threshold)
    if has_student_loan and gross_income > params["sl_plan2_threshold"]:
        sl_rate = params["sl_repayment_rate"]
    else:
        sl_rate = 0.0

    total_rate = it_rate + ni_rate + sl_rate

    return {
        "gross_income": gross_income,
        "income_tax_rate": it_rate,
        "ni_rate": ni_rate,
        "student_loan_rate": sl_rate,
        "total_marginal_rate": total_rate,
        "has_student_loan": has_student_loan,
    }


def calculate_marginal_rates_policyengine(
    age: int,
    has_student_loan: bool,
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    num_points: int = 301,
) -> pd.DataFrame:
    """Calculate marginal deduction rates using PolicyEngine UK simulation.

    Creates a single adult household and varies employment income to
    compute effective marginal rates including all interactions.

    Args:
        age: Age of the individual.
        has_student_loan: Whether they have a Plan 2 student loan.
        year: Tax year for calculation.
        income_range: (min, max) employment income range.
        num_points: Number of income points to calculate.

    Returns:
        DataFrame with income levels and marginal rate breakdowns.
    """
    situation = {
        "people": {
            "adult": {
                "age": {year: age},
                "employment_income": {year: 0},
            }
        },
        "benunits": {
            "benunit": {
                "members": ["adult"],
            }
        },
        "households": {
            "household": {
                "members": ["adult"],
                "region": {year: "LONDON"},
            }
        },
        "axes": [
            [
                {
                    "name": "employment_income",
                    "min": income_range[0],
                    "max": income_range[1],
                    "count": num_points,
                    "period": str(year),
                }
            ]
        ],
    }

    # Add student loan if applicable
    if has_student_loan:
        situation["people"]["adult"]["student_loan_plan"] = {year: "PLAN_2"}

    sim = Simulation(situation=situation)

    # Get values
    employment_income = sim.calculate("employment_income", year)
    income_tax = sim.calculate("income_tax", year)
    ni = sim.calculate("national_insurance", year)
    student_loan = sim.calculate("student_loan_repayment", year)

    # Calculate marginal rates (change in deduction per £1 of income)
    delta = employment_income[1] - employment_income[0]

    income_tax_marginal = np.gradient(income_tax, delta)
    ni_marginal = np.gradient(ni, delta)
    sl_marginal = np.gradient(student_loan, delta)
    total_marginal = income_tax_marginal + ni_marginal + sl_marginal

    return pd.DataFrame(
        {
            "employment_income": employment_income,
            "income_tax": income_tax,
            "national_insurance": ni,
            "student_loan_repayment": student_loan,
            "income_tax_marginal_rate": income_tax_marginal,
            "ni_marginal_rate": ni_marginal,
            "student_loan_marginal_rate": sl_marginal,
            "total_marginal_rate": total_marginal,
            "age": age,
            "has_student_loan": has_student_loan,
        }
    )


def generate_cohort_comparison(
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    num_points: int = 301,
) -> pd.DataFrame:
    """Generate marginal rate comparison across age cohorts.

    Args:
        year: Tax year for calculation.
        income_range: (min, max) employment income range.
        num_points: Number of income points.

    Returns:
        DataFrame with all cohorts' marginal rates.
    """
    all_results = []

    for cohort in AGE_COHORTS:
        df = calculate_marginal_rates_policyengine(
            age=cohort.age,
            has_student_loan=cohort.has_plan2_loan,
            year=year,
            income_range=income_range,
            num_points=num_points,
        )
        df["cohort_name"] = cohort.name
        df["cohort_description"] = cohort.description
        all_results.append(df)

    return pd.concat(all_results, ignore_index=True)


def generate_simple_comparison(
    year: int = 2026,
    income_range: tuple[int, int] = (0, 150_000),
    step: int = 1_000,
) -> pd.DataFrame:
    """Generate statutory rate comparison using PE UK parameters.

    Args:
        year: Tax year for parameter lookup.
        income_range: (min, max) employment income range.
        step: Income step size.

    Returns:
        DataFrame comparing with/without student loan.
    """
    params = get_tax_parameters(year)
    incomes = range(income_range[0], income_range[1] + 1, step)
    results = []

    for income in incomes:
        # With student loan
        with_sl = calculate_marginal_rate(income, params, has_student_loan=True)
        with_sl["scenario"] = "With Plan 2 loan (under 35)"
        results.append(with_sl)

        # Without student loan
        without_sl = calculate_marginal_rate(
            income, params, has_student_loan=False
        )
        without_sl["scenario"] = "No student loan (over 40)"
        results.append(without_sl)

    return pd.DataFrame(results)


def get_key_thresholds(year: int = 2026) -> list[dict]:
    """Return key income thresholds and their marginal rate implications.

    All values read from PolicyEngine UK parameters.

    Args:
        year: Tax year for parameter lookup.

    Returns:
        List of threshold dictionaries with rates.
    """
    p = get_tax_parameters(year)

    basic_rate_pct = int(p["basic_rate"] * 100)
    higher_rate_pct = int(p["higher_rate"] * 100)
    additional_rate_pct = int(p["additional_rate"] * 100)
    ni_main_pct = int(p["ni_main_rate"] * 100)
    ni_higher_pct = int(p["ni_higher_rate"] * 100)
    sl_rate_pct = int(p["sl_repayment_rate"] * 100)

    # PA taper effective rate
    pa_taper_it = int(
        (p["higher_rate"] + p["basic_rate"] * p["pa_taper_rate"]) * 100
    )

    return [
        {
            "threshold": int(p["personal_allowance"]),
            "description": "Personal allowance (income tax starts)",
            "rate_without_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
            "rate_with_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
        },
        {
            "threshold": int(p["sl_plan2_threshold"]),
            "description": "Plan 2 student loan threshold",
            "rate_without_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI = {basic_rate_pct + ni_main_pct}%",
            "rate_with_sl": f"{basic_rate_pct}% IT + {ni_main_pct}% NI + {sl_rate_pct}% SL = {basic_rate_pct + ni_main_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["basic_rate_threshold"]),
            "description": "Higher rate threshold / NI UEL",
            "rate_without_sl": f"{higher_rate_pct}% IT + {ni_higher_pct}% NI = {higher_rate_pct + ni_higher_pct}%",
            "rate_with_sl": f"{higher_rate_pct}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {higher_rate_pct + ni_higher_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["pa_taper_threshold"]),
            "description": "Personal allowance taper starts",
            "rate_without_sl": f"{pa_taper_it}% IT + {ni_higher_pct}% NI = {pa_taper_it + ni_higher_pct}%",
            "rate_with_sl": f"{pa_taper_it}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {pa_taper_it + ni_higher_pct + sl_rate_pct}%",
        },
        {
            "threshold": int(p["higher_rate_threshold"]),
            "description": "Additional rate threshold (PA gone)",
            "rate_without_sl": f"{additional_rate_pct}% IT + {ni_higher_pct}% NI = {additional_rate_pct + ni_higher_pct}%",
            "rate_with_sl": f"{additional_rate_pct}% IT + {ni_higher_pct}% NI + {sl_rate_pct}% SL = {additional_rate_pct + ni_higher_pct + sl_rate_pct}%",
        },
    ]


def calculate_lifetime_additional_deductions(
    starting_salary: float = 30_000,
    salary_growth_rate: float = 0.03,
    years_of_work: int = 40,
    loan_forgiveness_year: int = 30,
    year: int = 2026,
) -> dict:
    """Calculate lifetime additional deductions from student loan.

    Estimates how much more a Plan 2 graduate pays vs someone without a loan
    over their working life, assuming the loan isn't paid off early.

    Args:
        starting_salary: Starting annual salary at age 22.
        salary_growth_rate: Annual salary growth rate.
        years_of_work: Years of employment.
        loan_forgiveness_year: Year when loan is forgiven (30 for Plan 2).
        year: Tax year for parameter lookup.

    Returns:
        Dict with lifetime totals and annual breakdown.
    """
    params = get_tax_parameters(year)
    annual_results = []
    total_extra_deductions = 0
    total_loan_repayments = 0

    for yr in range(years_of_work):
        salary = starting_salary * ((1 + salary_growth_rate) ** yr)

        # Calculate what they'd pay with vs without loan
        with_loan = calculate_marginal_rate(salary, params, has_student_loan=True)
        without_loan = calculate_marginal_rate(
            salary, params, has_student_loan=False
        )

        # Student loan repayment amount (if above threshold and within 30 years)
        if yr < loan_forgiveness_year and salary > params["sl_plan2_threshold"]:
            sl_repayment = (
                salary - params["sl_plan2_threshold"]
            ) * params["sl_repayment_rate"]
        else:
            sl_repayment = 0

        total_loan_repayments += sl_repayment

        # The "extra" they pay is the student loan repayment itself
        extra_this_year = sl_repayment
        total_extra_deductions += extra_this_year

        annual_results.append(
            {
                "year": yr + 1,
                "age": 22 + yr,
                "salary": salary,
                "student_loan_repayment": sl_repayment,
                "marginal_rate_with_loan": with_loan["total_marginal_rate"],
                "marginal_rate_without_loan": without_loan["total_marginal_rate"],
                "marginal_rate_difference": (
                    with_loan["total_marginal_rate"]
                    - without_loan["total_marginal_rate"]
                ),
            }
        )

    return {
        "total_student_loan_repayments": total_loan_repayments,
        "total_extra_deductions": total_extra_deductions,
        "average_annual_extra": total_extra_deductions
        / min(years_of_work, loan_forgiveness_year),
        "annual_breakdown": annual_results,
        "parameters_used": {
            "sl_threshold": params["sl_plan2_threshold"],
            "sl_rate": params["sl_repayment_rate"],
        },
    }


def export_to_csv(
    df: pd.DataFrame,
    filename: str = "student_loan_effective_ni.csv",
) -> str:
    """Export results to CSV for frontend consumption.

    Args:
        df: DataFrame with marginal rate data.
        filename: Output filename.

    Returns:
        Path to the saved file.
    """
    output_path = f"public/data/{filename}"
    df.to_csv(output_path, index=False)
    return output_path


def export_parameters_csv(years: list[int] = None) -> str:
    """Export tax parameters for multiple years to CSV.

    Args:
        years: List of years to export. Defaults to 2025-2030.

    Returns:
        Path to the saved file.
    """
    if years is None:
        years = [2025, 2026, 2027, 2028, 2029, 2030]

    rows = []
    for year in years:
        params = get_tax_parameters(year)
        params["year"] = year
        rows.append(params)

    df = pd.DataFrame(rows)
    output_path = "public/data/student_loan_parameters.csv"
    df.to_csv(output_path, index=False)
    print(f"Exported parameters to {output_path}")
    return output_path


if __name__ == "__main__":
    print("Generating student loan as effective NI analysis...")
    print("(All rates read from PolicyEngine UK parameters)\n")

    # Export parameters for all years first
    export_parameters_csv()

    # Load and display parameters
    year = 2026
    params = get_tax_parameters(year)
    print(f"=== {year} Tax Parameters (from PE UK) ===")
    print(f"Personal allowance: £{params['personal_allowance']:,}")
    print(f"Basic rate: {params['basic_rate']*100:.0f}%")
    print(f"Higher rate: {params['higher_rate']*100:.0f}%")
    print(f"Additional rate: {params['additional_rate']*100:.0f}%")
    print(f"Basic rate threshold: £{params['basic_rate_threshold']:,.0f}")
    print(f"Higher rate threshold: £{params['higher_rate_threshold']:,}")
    print(f"PA taper threshold: £{params['pa_taper_threshold']:,}")
    print(f"\nNI primary threshold: £{params['ni_primary_threshold']:,.0f}")
    print(f"NI UEL: £{params['ni_upper_earnings_limit']:,.0f}")
    print(f"NI main rate: {params['ni_main_rate']*100:.0f}%")
    print(f"NI higher rate: {params['ni_higher_rate']*100:.0f}%")
    print(f"\nStudent loan Plan 2 threshold: £{params['sl_plan2_threshold']:,}")
    print(f"Student loan repayment rate: {params['sl_repayment_rate']*100:.0f}%")

    # Simple comparison
    simple_df = generate_simple_comparison(year=year)
    print("\n=== Simple Rate Comparison ===")
    sample_incomes = [30_000, 50_000, 80_000, 120_000]
    for income in sample_incomes:
        row_with = simple_df[
            (simple_df["gross_income"] == income)
            & (simple_df["scenario"] == "With Plan 2 loan (under 35)")
        ].iloc[0]
        row_without = simple_df[
            (simple_df["gross_income"] == income)
            & (simple_df["scenario"] == "No student loan (over 40)")
        ].iloc[0]
        print(f"\n£{income:,}:")
        print(
            f"  Without loan: {row_without['total_marginal_rate']*100:.0f}% "
            f"(IT: {row_without['income_tax_rate']*100:.0f}%, "
            f"NI: {row_without['ni_rate']*100:.0f}%)"
        )
        print(
            f"  With Plan 2:  {row_with['total_marginal_rate']*100:.0f}% "
            f"(IT: {row_with['income_tax_rate']*100:.0f}%, "
            f"NI: {row_with['ni_rate']*100:.0f}%, "
            f"SL: {row_with['student_loan_rate']*100:.0f}%)"
        )

    # Key thresholds
    print("\n=== Key Marginal Rate Thresholds ===")
    for t in get_key_thresholds(year):
        print(f"\n£{t['threshold']:,}: {t['description']}")
        print(f"  Without loan: {t['rate_without_sl']}")
        print(f"  With Plan 2:  {t['rate_with_sl']}")

    # Lifetime impact
    print("\n=== Lifetime Additional Deductions (£30k start, 3% growth) ===")
    lifetime = calculate_lifetime_additional_deductions(year=year)
    print(
        f"Student loan threshold: £{lifetime['parameters_used']['sl_threshold']:,}"
    )
    print(
        f"Repayment rate: {lifetime['parameters_used']['sl_rate']*100:.0f}%"
    )
    print(
        f"Total student loan repayments over career: "
        f"£{lifetime['total_student_loan_repayments']:,.0f}"
    )
    print(
        f"Average annual repayment (first 30 years): "
        f"£{lifetime['average_annual_extra']:,.0f}"
    )

    # PolicyEngine simulation comparison
    try:
        print("\n=== PolicyEngine Full Simulation Comparison ===")
        cohort_df = generate_cohort_comparison(year=year, num_points=31)

        # Show rates at key income levels
        for income in sample_incomes:
            print(f"\nAt £{income:,} gross income:")
            subset = cohort_df[
                cohort_df["employment_income"].between(income - 2500, income + 2500)
            ]
            for cohort_name in subset["cohort_name"].unique():
                row = subset[subset["cohort_name"] == cohort_name].iloc[0]
                print(
                    f"  {cohort_name}: {row['total_marginal_rate']*100:.1f}% "
                    f"(IT: {row['income_tax_marginal_rate']*100:.1f}%, "
                    f"NI: {row['ni_marginal_rate']*100:.1f}%, "
                    f"SL: {row['student_loan_marginal_rate']*100:.1f}%)"
                )

        # Export for dashboard
        export_to_csv(cohort_df, "student_loan_marginal_rates.csv")
        print("\nExported to public/data/student_loan_marginal_rates.csv")

    except Exception as e:
        print(f"\nPolicyEngine simulation comparison failed: {e}")
        import traceback

        traceback.print_exc()
