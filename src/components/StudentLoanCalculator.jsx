import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";
import "./StudentLoanCalculator.css";

// Default parameters (will be overwritten by CSV data)
const DEFAULT_PARAMS = {
  personalAllowance: 12570,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  basicRateThreshold: 50270,
  higherRateThreshold: 125140,
  paTaperThreshold: 100000,
  paTaperRate: 0.5,
  niPrimaryThreshold: 12570,
  niUEL: 50270,
  niMainRate: 0.08,
  niHigherRate: 0.02,
  slRepaymentRate: 0.09,
  slPlan1Threshold: 27039,
  slPlan2Threshold: 29385,
  slPlan4Threshold: 33970,
  slPlan5Threshold: 25000,
  slPostgradThreshold: 22722,
  slPostgradRate: 0.06,
};

// Colours following PolicyEngine design system
const COLORS = {
  primary: "#319795",
  incomeTax: "#14B8A6",
  ni: "#5EEAD4",
  studentLoan: "#F59E0B",
  postgradLoan: "#DC2626",
  withLoan: "#319795",
  withoutLoan: "#9CA3AF",
  text: "#101828",
  textSecondary: "#475569",
  border: "#E2E8F0",
};

// Calculate marginal rate at a given income
function calculateMarginalRate(grossIncome, params, plan = "none", hasPostgrad = false) {
  let itRate = 0;
  let niRate = 0;
  let slRate = 0;
  let postgradRate = 0;

  if (grossIncome <= params.personalAllowance) {
    itRate = 0;
  } else if (grossIncome <= params.basicRateThreshold) {
    itRate = params.basicRate;
  } else if (grossIncome <= params.higherRateThreshold) {
    itRate = params.higherRate;
  } else {
    itRate = params.additionalRate;
  }

  if (grossIncome > params.paTaperThreshold && grossIncome <= params.higherRateThreshold) {
    itRate = params.higherRate + params.basicRate * params.paTaperRate;
  }

  if (grossIncome <= params.niPrimaryThreshold) {
    niRate = 0;
  } else if (grossIncome <= params.niUEL) {
    niRate = params.niMainRate;
  } else {
    niRate = params.niHigherRate;
  }

  const planThreshold = getPlanThreshold(params, plan);
  if (plan !== "none" && grossIncome > planThreshold) {
    slRate = params.slRepaymentRate;
  }

  if (hasPostgrad && grossIncome > params.slPostgradThreshold) {
    postgradRate = params.slPostgradRate;
  }

  return {
    grossIncome,
    incomeTaxRate: itRate,
    niRate,
    studentLoanRate: slRate,
    postgradRate,
    totalRate: itRate + niRate + slRate + postgradRate,
  };
}

// Calculate actual deductions
function calculateDeductions(grossIncome, params, plan = "none", hasPostgrad = false) {
  let incomeTax = 0;
  let effectivePA = params.personalAllowance;

  if (grossIncome > params.paTaperThreshold) {
    const reduction = (grossIncome - params.paTaperThreshold) * params.paTaperRate;
    effectivePA = Math.max(0, params.personalAllowance - reduction);
  }

  const taxable = Math.max(0, grossIncome - effectivePA);
  if (taxable > 0) {
    const basicBand = Math.min(taxable, params.basicRateThreshold - params.personalAllowance);
    incomeTax += basicBand * params.basicRate;
    const higherBand = Math.min(
      Math.max(0, taxable - basicBand),
      params.higherRateThreshold - params.basicRateThreshold
    );
    incomeTax += higherBand * params.higherRate;
    const additionalBand = Math.max(0, taxable - basicBand - higherBand);
    incomeTax += additionalBand * params.additionalRate;
  }

  let ni = 0;
  if (grossIncome > params.niPrimaryThreshold) {
    const mainBand = Math.min(
      grossIncome - params.niPrimaryThreshold,
      params.niUEL - params.niPrimaryThreshold
    );
    ni += mainBand * params.niMainRate;
    if (grossIncome > params.niUEL) {
      ni += (grossIncome - params.niUEL) * params.niHigherRate;
    }
  }

  let studentLoan = 0;
  const planThreshold = getPlanThreshold(params, plan);
  if (plan !== "none" && grossIncome > planThreshold) {
    studentLoan = (grossIncome - planThreshold) * params.slRepaymentRate;
  }

  let postgradLoan = 0;
  if (hasPostgrad && grossIncome > params.slPostgradThreshold) {
    postgradLoan = (grossIncome - params.slPostgradThreshold) * params.slPostgradRate;
  }

  return {
    grossIncome,
    incomeTax,
    ni,
    studentLoan,
    postgradLoan,
    totalDeductions: incomeTax + ni + studentLoan + postgradLoan,
    netIncome: grossIncome - incomeTax - ni - studentLoan - postgradLoan,
  };
}

// Generate marginal rate data
function generateMarginalRateData(params, plan = "plan2", hasPostgrad = false) {
  const data = [];
  for (let income = 0; income <= 150000; income += 500) {
    const withLoan = calculateMarginalRate(income, params, plan, hasPostgrad);
    const withoutLoan = calculateMarginalRate(income, params, "none", false);
    data.push({
      income,
      withLoan: withLoan.totalRate * 100,
      withoutLoan: withoutLoan.totalRate * 100,
      incomeTax: withLoan.incomeTaxRate * 100,
      ni: withLoan.niRate * 100,
      studentLoan: withLoan.studentLoanRate * 100,
      postgrad: (withLoan.postgradRate || 0) * 100,
      difference: (withLoan.totalRate - withoutLoan.totalRate) * 100,
    });
  }
  return data;
}

// Generate take-home pay data
function generateTakeHomeData(params, plan = "plan2", hasPostgrad = false) {
  const data = [];
  for (let income = 0; income <= 150000; income += 2500) {
    const withLoan = calculateDeductions(income, params, plan, hasPostgrad);
    const withoutLoan = calculateDeductions(income, params, "none", false);
    data.push({
      income,
      withLoan: Math.round(withLoan.netIncome),
      withoutLoan: Math.round(withoutLoan.netIncome),
      difference: Math.round(withoutLoan.netIncome - withLoan.netIncome),
    });
  }
  return data;
}

// Generate age-based comparison data
// Assumes workers under a cutoff age have student loans, those above don't
function generateAgeData(salary, params, plan = "plan2", hasPostgrad = false, loanCutoffAge = 40) {
  const data = [];
  for (let age = 22; age <= 60; age++) {
    const hasLoan = age < loanCutoffAge;
    const rate = calculateMarginalRate(salary, params, hasLoan ? plan : "none", hasLoan ? hasPostgrad : false);
    data.push({
      age,
      hasLoan,
      totalRate: rate.totalRate * 100,
      incomeTax: rate.incomeTaxRate * 100,
      ni: rate.niRate * 100,
      studentLoan: rate.studentLoanRate * 100,
      postgrad: (rate.postgradRate || 0) * 100,
    });
  }
  return data;
}

// Parse CSV row into params object
function parseParamsRow(row) {
  return {
    personalAllowance: parseFloat(row.personal_allowance),
    basicRate: parseFloat(row.basic_rate),
    higherRate: parseFloat(row.higher_rate),
    additionalRate: parseFloat(row.additional_rate),
    basicRateThreshold: parseFloat(row.basic_rate_threshold),
    higherRateThreshold: parseFloat(row.higher_rate_threshold),
    paTaperThreshold: parseFloat(row.pa_taper_threshold),
    paTaperRate: parseFloat(row.pa_taper_rate),
    niPrimaryThreshold: parseFloat(row.ni_primary_threshold),
    niUEL: parseFloat(row.ni_upper_earnings_limit),
    niMainRate: parseFloat(row.ni_main_rate),
    niHigherRate: parseFloat(row.ni_higher_rate),
    slRepaymentRate: parseFloat(row.sl_repayment_rate),
    slPlan1Threshold: parseFloat(row.sl_plan1_threshold),
    slPlan2Threshold: parseFloat(row.sl_plan2_threshold),
    slPlan4Threshold: parseFloat(row.sl_plan4_threshold),
    slPlan5Threshold: parseFloat(row.sl_plan5_threshold),
    slPostgradThreshold: parseFloat(row.sl_postgrad_threshold),
    slPostgradRate: parseFloat(row.sl_postgrad_rate),
    // Interest rates
    slPlan1Interest: parseFloat(row.sl_plan1_interest) || 0.045,
    slPlan2InterestMin: parseFloat(row.sl_plan2_interest_min) || 0.045,
    slPlan2InterestMax: parseFloat(row.sl_plan2_interest_max) || 0.078,
    slPlan4Interest: parseFloat(row.sl_plan4_interest) || 0.045,
    slPlan5Interest: parseFloat(row.sl_plan5_interest) || 0.045,
    // Write-off periods
    slPlan1Writeoff: parseInt(row.sl_plan1_writeoff) || 25,
    slPlan2Writeoff: parseInt(row.sl_plan2_writeoff) || 30,
    slPlan4Writeoff: parseInt(row.sl_plan4_writeoff) || 30,
    slPlan5Writeoff: parseInt(row.sl_plan5_writeoff) || 40,
  };
}

// Student loan plan options
const PLAN_OPTIONS = [
  { value: "none", label: "No student loan", threshold: null },
  { value: "plan1", label: "Plan 1", threshold: "slPlan1Threshold", description: "Started before Sept 2012 (Eng/Wales) or Scotland/NI" },
  { value: "plan2", label: "Plan 2", threshold: "slPlan2Threshold", description: "Started Sept 2012+ (England/Wales)" },
  { value: "plan4", label: "Plan 4", threshold: "slPlan4Threshold", description: "Scotland" },
  { value: "plan5", label: "Plan 5", threshold: "slPlan5Threshold", description: "Started Aug 2023+ (England)" },
];

function getPlanThreshold(params, plan) {
  const thresholds = {
    plan1: params.slPlan1Threshold,
    plan2: params.slPlan2Threshold,
    plan4: params.slPlan4Threshold,
    plan5: params.slPlan5Threshold,
  };
  return thresholds[plan] || params.slPlan2Threshold;
}

// Get plan write-off period from params
function getPlanWriteoffYears(params, plan) {
  const writeoffs = {
    plan1: params.slPlan1Writeoff || 25,
    plan2: params.slPlan2Writeoff || 30,
    plan4: params.slPlan4Writeoff || 30,
    plan5: params.slPlan5Writeoff || 40,
    none: 0,
  };
  return writeoffs[plan] || 30;
}

// Client-side calculation functions removed - all data comes from API

// API URL - uses environment variable if set, otherwise production Cloud Run URL
const getApiUrl = () => {
  return import.meta.env.VITE_API_URL || "https://student-loan-calculator-578039519715.europe-west1.run.app";
};

// Format year as UK tax year (e.g., 2026 -> "2026-27")
const formatTaxYear = (year) => `${year}-${String(year + 1).slice(-2)}`;

export default function StudentLoanCalculator() {
  const [allParams, setAllParams] = useState({});
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const [selectedYear, setSelectedYear] = useState(2026);
  const [selectedPlan, setSelectedPlan] = useState("plan2");
  const [showPostgrad, setShowPostgrad] = useState(false);
  const [exampleSalary, setExampleSalary] = useState(40000);
  const [age, setAge] = useState(28);
  const [loanAmount, setLoanAmount] = useState(40000);
  const [salaryGrowthRate, setSalaryGrowthRate] = useState(0.03);
  const [customInterestRate, setCustomInterestRate] = useState(0.04); // default 4%

  // API data state
  const [apiData, setApiData] = useState(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [policyChartView, setPolicyChartView] = useState("annual"); // "annual" or "cumulative"

  // Loan cutoff age varies by plan (graduation age ~22 + write-off period)
  const PLAN_WRITEOFF_AGES = {
    plan1: 47,  // 25 years after first repayment
    plan2: 52,  // 30 years after first repayment
    plan4: 52,  // 30 years after first repayment
    plan5: 62,  // 40 years after first repayment
    none: 60,
  };
  const loanCutoffAge = PLAN_WRITEOFF_AGES[selectedPlan] || 52;
  const chartRef = useRef(null);
  const takeHomeChartRef = useRef(null);
  const ageChartRef = useRef(null);
  const lifetimeChartRef = useRef(null);
  const policyChartRef = useRef(null);
  const tooltipRef = useRef(null);

  // Scroll spy state and refs
  const [activeSection, setActiveSection] = useState("overview");
  const sectionRefs = {
    overview: useRef(null),
    breakdown: useRef(null),
    marginalRates: useRef(null),
    takeHome: useRef(null),
    byAge: useRef(null),
    lifetime: useRef(null),
  };

  const sections = [
    { id: "overview", label: "Overview" },
    { id: "marginalRates", label: "Marginal rates" },
    { id: "breakdown", label: "Breakdown" },
    { id: "takeHome", label: "Take-home" },
    { id: "byAge", label: "By age" },
    { id: "lifetime", label: "Lifetime" },
  ];

  // Scroll spy effect
  useEffect(() => {
    const observerOptions = {
      root: null,
      rootMargin: "-20% 0px -60% 0px",
      threshold: 0,
    };

    const observerCallback = (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveSection(entry.target.id);
        }
      });
    };

    const observer = new IntersectionObserver(observerCallback, observerOptions);

    Object.values(sectionRefs).forEach((ref) => {
      if (ref.current) {
        observer.observe(ref.current);
      }
    });

    return () => observer.disconnect();
  }, []);

  // Load parameters from CSV
  useEffect(() => {
    fetch('/data/student_loan_parameters.csv')
      .then(response => response.text())
      .then(csvText => {
        const lines = csvText.trim().split('\n');
        const headers = lines[0].split(',');
        const paramsMap = {};

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          const row = {};
          headers.forEach((header, idx) => {
            row[header] = values[idx];
          });
          const year = parseInt(row.year);
          paramsMap[year] = parseParamsRow(row);
        }

        setAllParams(paramsMap);
        setParamsLoaded(true);
      })
      .catch(err => {
        console.error('Failed to load parameters:', err);
        setAllParams({ 2026: DEFAULT_PARAMS });
        setParamsLoaded(true);
      });
  }, []);

  // Fetch data from API
  const fetchApiData = useCallback(async () => {
    if (selectedPlan === "none") {
      setApiData(null);
      return;
    }

    setApiLoading(true);
    setApiError(null);

    try {
      const requestBody = {
        starting_salary: exampleSalary,
        loan_amount: loanAmount,
        plan: selectedPlan,
        salary_growth_rate: salaryGrowthRate,
        year: selectedYear,
        has_postgrad: showPostgrad,
      };
      // Add custom interest rate if set
      if (customInterestRate !== null) {
        requestBody.interest_rate = customInterestRate;
      }

      const response = await fetch(`${getApiUrl()}/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      setApiData(result);
    } catch (err) {
      console.error("Error fetching data:", err);
      setApiError(err.message);
    } finally {
      setApiLoading(false);
    }
  }, [exampleSalary, loanAmount, selectedPlan, salaryGrowthRate, selectedYear, showPostgrad, customInterestRate]);

  // Debounced fetch on input change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchApiData();
    }, 300);
    return () => clearTimeout(timer);
  }, [fetchApiData]);

  const params = useMemo(() => {
    if (!paramsLoaded) return DEFAULT_PARAMS;
    return allParams[selectedYear] || DEFAULT_PARAMS;
  }, [allParams, selectedYear, paramsLoaded]);

  const marginalRateData = useMemo(() => generateMarginalRateData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);
  const takeHomeData = useMemo(() => generateTakeHomeData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);
  const ageData = useMemo(() => generateAgeData(exampleSalary, params, selectedPlan, showPostgrad, loanCutoffAge), [exampleSalary, params, selectedPlan, showPostgrad, loanCutoffAge]);

  // Data from API - transform to chart format (no fallbacks)
  const lifetimeData = useMemo(() => {
    if (selectedPlan === "none" || !apiData?.lifetime_data) return [];
    return apiData.lifetime_data.map(d => ({
      year: d.year,
      salary: d.salary,
      annualRepayment: d.annual_repayment,
      totalRepaid: d.total_repaid,
      remainingBalance: d.balance_end,
      interestCharge: d.interest_charge,
      writeOff: d.written_off || 0,
    }));
  }, [apiData, selectedPlan]);

  // Policy data from API
  const policyData = useMemo(() => {
    if (selectedPlan === "none" || !apiData?.policy_data) return [];
    return apiData.policy_data.map(d => ({
      year: d.year,
      calendarYear: d.calendar_year,
      // Annual values (for each year)
      annualRepaidFrozen: d.annual_repaid_frozen,
      annualRepaidIndexed: d.annual_repaid_indexed,
      annualImpact: d.annual_impact,
      // Cumulative values (total over lifetime)
      totalRepaidFrozen: d.total_repaid_frozen,
      totalRepaidIndexed: d.total_repaid_indexed,
      cumulativeImpact: d.cumulative_impact,
      // Thresholds
      thresholdFrozen: d.threshold_frozen,
      thresholdIndexed: d.threshold_indexed,
      // Balance tracking for filtering
      balanceFrozen: d.balance_frozen || 0,
      balanceIndexed: d.balance_indexed || 0,
    }));
  }, [apiData, selectedPlan]);

  // Example calculations
  const hasLoan = selectedPlan !== "none";
  const planThreshold = getPlanThreshold(params, selectedPlan);
  const withLoan = useMemo(() => calculateDeductions(exampleSalary, params, selectedPlan, showPostgrad), [exampleSalary, params, selectedPlan, showPostgrad]);
  const withoutLoan = useMemo(() => calculateDeductions(exampleSalary, params, "none", false), [exampleSalary, params]);
  const marginalWithLoan = useMemo(() => calculateMarginalRate(exampleSalary, params, selectedPlan, showPostgrad), [exampleSalary, params, selectedPlan, showPostgrad]);
  const marginalWithoutLoan = useMemo(() => calculateMarginalRate(exampleSalary, params, "none", false), [exampleSalary, params]);

  // Chart 1: Marginal Rate
  useEffect(() => {
    if (!chartRef.current || !marginalRateData.length || !paramsLoaded) return;

    const container = chartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const svg = d3.select(container)
      .append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, 150000]).range([0, width]);
    const y = d3.scaleLinear().domain([0, 80]).range([height, 0]);

    // Grid
    g.append("g").attr("class", "grid")
      .call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(8));

    // Stacked areas
    const areaIT = d3.area()
      .x((d) => x(d.income))
      .y0(y(0))
      .y1((d) => y(d.incomeTax))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", COLORS.incomeTax)
      .attr("fill-opacity", 0.7)
      .attr("d", areaIT);

    const areaNI = d3.area()
      .x((d) => x(d.income))
      .y0((d) => y(d.incomeTax))
      .y1((d) => y(d.incomeTax + d.ni))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", COLORS.ni)
      .attr("fill-opacity", 0.7)
      .attr("d", areaNI);

    const areaSL = d3.area()
      .x((d) => x(d.income))
      .y0((d) => y(d.incomeTax + d.ni))
      .y1((d) => y(d.incomeTax + d.ni + d.studentLoan))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", COLORS.studentLoan)
      .attr("fill-opacity", 0.7)
      .attr("d", areaSL);

    if (showPostgrad) {
      const areaPG = d3.area()
        .x((d) => x(d.income))
        .y0((d) => y(d.incomeTax + d.ni + d.studentLoan))
        .y1((d) => y(d.incomeTax + d.ni + d.studentLoan + d.postgrad))
        .curve(d3.curveStepAfter);

      g.append("path")
        .datum(marginalRateData)
        .attr("fill", COLORS.postgradLoan)
        .attr("fill-opacity", 0.7)
        .attr("d", areaPG);
    }

    // Lines
    const lineWithLoan = d3.line()
      .x((d) => x(d.income))
      .y((d) => y(d.withLoan))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 3.5)
      .attr("d", lineWithLoan);

    const lineWithoutLoan = d3.line()
      .x((d) => x(d.income))
      .y((d) => y(d.withoutLoan))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 3.5)
      .attr("stroke-dasharray", "6,3")
      .attr("d", lineWithoutLoan);

    // Highlight selected salary with vertical line
    if (exampleSalary > 0 && exampleSalary <= 150000) {
      const rateWithLoan = marginalWithLoan.totalRate * 100;
      const rateWithoutLoan = marginalWithoutLoan.totalRate * 100;

      g.append("line")
        .attr("x1", x(exampleSalary)).attr("x2", x(exampleSalary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", COLORS.primary).attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      // Point on with-loan line
      g.append("circle")
        .attr("cx", x(exampleSalary)).attr("cy", y(rateWithLoan)).attr("r", 6)
        .attr("fill", "#344054").attr("stroke", "#fff").attr("stroke-width", 2);

      // Point on without-loan line
      g.append("circle")
        .attr("cx", x(exampleSalary)).attr("cy", y(rateWithoutLoan)).attr("r", 6)
        .attr("fill", "#344054").attr("stroke", "#fff").attr("stroke-width", 2);

      // Label showing the difference
      const diff = rateWithLoan - rateWithoutLoan;
      if (diff > 0) {
        g.append("text")
          .attr("x", x(exampleSalary) + 8).attr("y", 15)
          .attr("font-size", "12px").attr("font-weight", "600").attr("fill", COLORS.studentLoan)
          .text(`+${diff.toFixed(0)}pp`);
      }
    }

    // Axes
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat((d) => `£${d / 1000}k`).ticks(6));
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Gross income");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat((d) => `${d}%`).ticks(8));
    g.append("text").attr("transform", "rotate(-90)").attr("x", -height / 2).attr("y", -50).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Marginal deduction rate");

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);
    const bisect = d3.bisector((d) => d.income).left;

    g.append("rect").attr("width", width).attr("height", height).attr("fill", "none").attr("pointer-events", "all")
      .on("mousemove", function (event) {
        const [mx] = d3.pointer(event);
        const income = x.invert(mx);
        const i = bisect(marginalRateData, income, 1);
        const d = marginalRateData[Math.min(i, marginalRateData.length - 1)];
        const postgradRow = showPostgrad ? `<div class="tooltip-row"><span style="color:${COLORS.postgradLoan}">● Postgrad loan</span><span style="font-weight:600">${d.postgrad.toFixed(0)}%</span></div>` : '';
        tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
          .html(`<div class="tooltip-title">£${d3.format(",.0f")(d.income)}</div>
            <div class="tooltip-section">
              <div class="tooltip-row"><span style="color:${COLORS.incomeTax}">● Income tax</span><span style="font-weight:600">${d.incomeTax.toFixed(0)}%</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.ni}">● National Insurance</span><span style="font-weight:600">${d.ni.toFixed(0)}%</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.studentLoan}">● Student loan</span><span style="font-weight:600">${d.studentLoan.toFixed(0)}%</span></div>
              ${postgradRow}
            </div>
            <div class="tooltip-row tooltip-total"><span>With loan</span><span style="color:${COLORS.withLoan};font-weight:700">${d.withLoan.toFixed(0)}%</span></div>
            <div class="tooltip-row"><span>Without loan</span><span style="color:${COLORS.withoutLoan};font-weight:600">${d.withoutLoan.toFixed(0)}%</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [marginalRateData, params, paramsLoaded, showPostgrad, planThreshold, exampleSalary, marginalWithLoan, marginalWithoutLoan]);

  // Chart 2: Take-Home Pay
  useEffect(() => {
    if (!takeHomeChartRef.current || !paramsLoaded) return;

    const container = takeHomeChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, 150000]).range([0, width]);
    const y = d3.scaleLinear().domain([0, d3.max(takeHomeData, (d) => d.withoutLoan) * 1.05]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

    const lineWithLoan = d3.line().x((d) => x(d.income)).y((d) => y(d.withLoan)).curve(d3.curveMonotoneX);
    const lineWithoutLoan = d3.line().x((d) => x(d.income)).y((d) => y(d.withoutLoan)).curve(d3.curveMonotoneX);

    // Gap area
    const gapArea = d3.area().x((d) => x(d.income)).y0((d) => y(d.withLoan)).y1((d) => y(d.withoutLoan)).curve(d3.curveMonotoneX);
    if (hasLoan) {
      g.append("path").datum(takeHomeData.filter((d) => d.income >= planThreshold))
        .attr("fill", COLORS.studentLoan).attr("fill-opacity", 0.15).attr("d", gapArea);
    }

    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withoutLoan).attr("stroke-width", 3.5).attr("d", lineWithoutLoan);
    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withLoan).attr("stroke-width", 3.5).attr("d", lineWithLoan);

    // Highlight selected salary
    if (exampleSalary > 0 && exampleSalary <= 150000) {
      const netWithLoan = calculateDeductions(exampleSalary, params, selectedPlan, showPostgrad).netIncome;
      const netWithoutLoan = calculateDeductions(exampleSalary, params, "none", false).netIncome;

      g.append("line")
        .attr("x1", x(exampleSalary)).attr("x2", x(exampleSalary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", COLORS.primary).attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      g.append("circle")
        .attr("cx", x(exampleSalary)).attr("cy", y(netWithoutLoan)).attr("r", 6)
        .attr("fill", COLORS.withoutLoan).attr("stroke", "#fff").attr("stroke-width", 2);
      g.append("circle")
        .attr("cx", x(exampleSalary)).attr("cy", y(netWithLoan)).attr("r", 6)
        .attr("fill", COLORS.withLoan).attr("stroke", "#fff").attr("stroke-width", 2);

      const gap = netWithoutLoan - netWithLoan;
      if (gap > 0) {
        g.append("text")
          .attr("x", x(exampleSalary) + 8).attr("y", 15)
          .attr("font-size", "12px").attr("font-weight", "600").attr("fill", COLORS.studentLoan)
          .text(`-£${d3.format(",.0f")(gap)}/yr`);
      }
    }

    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat((d) => `£${d / 1000}k`).ticks(6));
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Gross income");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat((d) => `£${d / 1000}k`).ticks(6));

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);
    const bisect = d3.bisector((d) => d.income).left;

    g.append("rect").attr("width", width).attr("height", height).attr("fill", "none").attr("pointer-events", "all")
      .on("mousemove", function (event) {
        const [mx] = d3.pointer(event);
        const income = x.invert(mx);
        const i = bisect(takeHomeData, income, 1);
        const d = takeHomeData[Math.min(i, takeHomeData.length - 1)];
        const gap = d.withoutLoan - d.withLoan;
        tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
          .html(`<div class="tooltip-title">£${d3.format(",.0f")(d.income)} gross</div>
            <div class="tooltip-section">
              <div class="tooltip-row"><span style="color:${COLORS.withoutLoan}">● No loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.withoutLoan)}</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.withLoan}">● With loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.withLoan)}</span></div>
            </div>
            <div class="tooltip-row tooltip-total"><span>Difference</span><span style="color:${COLORS.studentLoan};font-weight:700">-£${d3.format(",.0f")(gap)}</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [takeHomeData, params, paramsLoaded, showPostgrad, exampleSalary, selectedPlan, hasLoan, planThreshold]);

  // Chart 3: Age-based comparison (stacked bars like UK Autumn Budget)
  useEffect(() => {
    if (!ageChartRef.current || !paramsLoaded) return;

    const container = ageChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(ageData.map((d) => d.age)).range([0, width]).padding(0.15);
    const y = d3.scaleLinear().domain([0, 80]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(8));

    // Reference line at loan cutoff age
    const cutoffX = x(loanCutoffAge);
    if (cutoffX !== undefined) {
      g.append("line")
        .attr("x1", cutoffX).attr("x2", cutoffX)
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", "#94a3b8").attr("stroke-width", 1.5).attr("stroke-dasharray", "6,4");
      g.append("text")
        .attr("x", cutoffX + 8).attr("y", 15)
        .attr("font-size", "11px").attr("fill", "#64748b").attr("font-weight", "500")
        .text(`Loan written off`);
    }

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);

    // Stacked bars - draw each component
    ageData.forEach((d) => {
      const isSelected = d.age === age;
      const barX = x(d.age);
      const barWidth = x.bandwidth();
      let currentY = height; // Start from bottom

      // Create invisible overlay for hover interaction
      const barGroup = g.append("g").attr("class", "bar-group");

      // Income tax bar (bottom)
      if (d.incomeTax > 0) {
        const barHeight = y(0) - y(d.incomeTax);
        currentY -= barHeight;
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", currentY)
          .attr("width", barWidth)
          .attr("height", barHeight)
          .attr("fill", COLORS.incomeTax);
      }

      // National Insurance bar (middle)
      if (d.ni > 0) {
        const barHeight = y(0) - y(d.ni);
        currentY -= barHeight;
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", currentY)
          .attr("width", barWidth)
          .attr("height", barHeight)
          .attr("fill", COLORS.ni);
      }

      // Student loan bar (if has loan)
      if (d.studentLoan > 0) {
        const barHeight = y(0) - y(d.studentLoan);
        currentY -= barHeight;
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", currentY)
          .attr("width", barWidth)
          .attr("height", barHeight)
          .attr("fill", COLORS.studentLoan);
      }

      // Postgrad loan bar (if applicable)
      if (d.postgrad > 0) {
        const barHeight = y(0) - y(d.postgrad);
        currentY -= barHeight;
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", currentY)
          .attr("width", barWidth)
          .attr("height", barHeight)
          .attr("fill", COLORS.postgradLoan);
      }

      // Selection highlight border
      if (isSelected) {
        barGroup.append("rect")
          .attr("x", barX - 1)
          .attr("y", y(d.totalRate) - 1)
          .attr("width", barWidth + 2)
          .attr("height", y(0) - y(d.totalRate) + 2)
          .attr("fill", "none")
          .attr("stroke", "#1a1a1a")
          .attr("stroke-width", 2)
          .attr("rx", 2);
      }

      // Invisible overlay for mouse interaction
      barGroup.append("rect")
        .attr("x", barX)
        .attr("y", 0)
        .attr("width", barWidth)
        .attr("height", height)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("mouseover", function (event) {
          barGroup.selectAll("rect:not(:last-child)").attr("opacity", 0.8);
          const postgradRow = d.postgrad > 0 ? `<div class="tooltip-row"><span style="color:${COLORS.postgradLoan}">● Postgrad loan</span><span style="font-weight:600">${d.postgrad.toFixed(0)}%</span></div>` : '';
          const slRow = d.studentLoan > 0 ? `<div class="tooltip-row"><span style="color:${COLORS.studentLoan}">● Student loan</span><span style="font-weight:600">${d.studentLoan.toFixed(0)}%</span></div>` : '';
          tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
            .html(`<div class="tooltip-title">Age ${d.age}</div>
              <div class="tooltip-section">
                <div class="tooltip-row"><span style="color:${COLORS.incomeTax}">● Income tax</span><span style="font-weight:600">${d.incomeTax.toFixed(0)}%</span></div>
                <div class="tooltip-row"><span style="color:${COLORS.ni}">● National Insurance</span><span style="font-weight:600">${d.ni.toFixed(0)}%</span></div>
                ${slRow}
                ${postgradRow}
              </div>
              <div class="tooltip-row tooltip-total"><span>Total marginal rate</span><span style="font-weight:700">${d.totalRate.toFixed(0)}%</span></div>`);
        })
        .on("mouseout", function () {
          barGroup.selectAll("rect:not(:last-child)").attr("opacity", 1);
          tooltip.style("opacity", 0);
        });
    });

    // X-axis with selective labels
    const xAxis = d3.axisBottom(x)
      .tickValues(ageData.filter((d) => d.age % 5 === 0 || d.age === 22 || d.age === loanCutoffAge).map((d) => d.age))
      .tickFormat((d) => d);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text(`Worker's age in ${formatTaxYear(selectedYear)}`);
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat((d) => `${d}%`).ticks(8));
  }, [ageData, paramsLoaded, age, loanCutoffAge, selectedPlan, selectedYear]);

  // Chart 4: Lifetime Repayment Analysis (stacked bars)
  useEffect(() => {
    if (!lifetimeChartRef.current || !paramsLoaded || !lifetimeData.length) return;

    const container = lifetimeChartRef.current;
    // Clear any existing content before rendering
    container.innerHTML = "";
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 80 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Filter out year 0 for bar chart, add age (graduation age + years)
    const graduationAge = age; // Use selected age as graduation age
    const barData = lifetimeData.filter(d => d.year > 0).map(d => ({
      ...d,
      age: graduationAge + d.year
    }));
    const maxAge = Math.max(...barData.map(d => d.age));
    const maxValue = Math.max(...barData.map(d => d.totalRepaid + d.remainingBalance));

    const x = d3.scaleBand().domain(barData.map(d => d.age)).range([0, width]).padding(0.15);
    const y = d3.scaleLinear().domain([0, maxValue * 1.1]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

    const tooltip = d3.select(tooltipRef.current);

    // Stacked bars for each age
    barData.forEach((d) => {
      const barX = x(d.age);
      const barWidth = x.bandwidth();
      const barGroup = g.append("g").attr("class", "bar-group");

      // Total repaid bar (bottom - positive, shown as teal)
      const repaidHeight = y(0) - y(d.totalRepaid);
      barGroup.append("rect")
        .attr("x", barX)
        .attr("y", y(d.totalRepaid))
        .attr("width", barWidth)
        .attr("height", repaidHeight)
        .attr("fill", COLORS.primary);

      // Remaining balance bar (stacked on top - shown as amber)
      const balanceHeight = y(0) - y(d.remainingBalance);
      barGroup.append("rect")
        .attr("x", barX)
        .attr("y", y(d.totalRepaid) - balanceHeight)
        .attr("width", barWidth)
        .attr("height", balanceHeight)
        .attr("fill", COLORS.studentLoan);

      // Write-off indicator for final year
      if (d.writeOff > 0) {
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", y(d.totalRepaid) - balanceHeight - 3)
          .attr("width", barWidth)
          .attr("height", 3)
          .attr("fill", COLORS.postgradLoan);
      }

      // Invisible overlay for mouse interaction
      barGroup.append("rect")
        .attr("x", barX)
        .attr("y", 0)
        .attr("width", barWidth)
        .attr("height", height)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("mouseover", function(event) {
          barGroup.selectAll("rect:not(:last-child)").attr("opacity", 0.8);
          const writeOffRow = d.writeOff > 0 ? `<div class="tooltip-row" style="color:${COLORS.postgradLoan}"><span>● Written off</span><span style="font-weight:600">£${d3.format(",.0f")(d.writeOff)}</span></div>` : '';
          tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
            .html(`<div class="tooltip-title">Age ${d.age} (Year ${d.year})</div>
              <div class="tooltip-section">
                <div class="tooltip-row"><span>Salary</span><span style="font-weight:600">£${d3.format(",.0f")(d.salary)}</span></div>
                <div class="tooltip-row"><span>Annual repayment</span><span style="font-weight:600">£${d3.format(",.0f")(d.annualRepayment)}</span></div>
                <div class="tooltip-row"><span>Interest charged</span><span style="font-weight:600">£${d3.format(",.0f")(d.interestCharge)}</span></div>
              </div>
              <div class="tooltip-row"><span style="color:${COLORS.primary}">● Total repaid</span><span style="font-weight:600">£${d3.format(",.0f")(d.totalRepaid)}</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.studentLoan}">● Balance remaining</span><span style="font-weight:600">£${d3.format(",.0f")(d.remainingBalance)}</span></div>
              ${writeOffRow}`);
        })
        .on("mouseout", function() {
          barGroup.selectAll("rect:not(:last-child)").attr("opacity", 1);
          tooltip.style("opacity", 0);
        });
    });

    // Axes
    const xAxis = d3.axisBottom(x)
      .tickValues(barData.filter(d => d.year % 5 === 0 || d.year === 1 || d.age === maxAge).map(d => d.age))
      .tickFormat(d => `${d}`);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Worker's age");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `£${d / 1000}k`).ticks(6));
  }, [lifetimeData, paramsLoaded, age]);

  // Removed: Chart 5 (Interest Rate Impact) and Combined Repayment chart

  // Chart 6: Policy Impact - Annual or Cumulative extra repayment due to threshold freeze
  useEffect(() => {
    if (!policyChartRef.current || !paramsLoaded || !policyData.length) return;

    const container = policyChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Filter out year 0, add age, and stop at the last year where there's still a balance remaining
    // (i.e., exclude the final payoff year where balance goes to 0)
    const graduationAge = age;

    // Find the last year where balance_frozen > 0 (still has balance after repayment)
    let lastYearWithBalance = 0;
    for (const d of policyData) {
      if (d.year > 0 && (d.balanceFrozen || 0) > 0) {
        lastYearWithBalance = d.year;
      }
    }

    const barData = policyData
      .filter(d => d.year > 0 && d.year <= lastYearWithBalance)
      .map(d => ({
        ...d,
        age: graduationAge + d.year
      }));

    if (barData.length === 0) return;

    const maxAge = Math.max(...barData.map(d => d.age));
    // Use annual or cumulative based on toggle
    const isCumulative = policyChartView === "cumulative";
    const getImpact = (d) => isCumulative ? (d.cumulativeImpact || 0) : (d.annualImpact || 0);
    const maxImpact = Math.max(...barData.map(d => getImpact(d)), 100);

    const x = d3.scaleBand().domain(barData.map(d => d.age)).range([0, width]).padding(0.15);
    const y = d3.scaleLinear().domain([0, maxImpact * 1.1]).nice().range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

    const tooltip = d3.select(tooltipRef.current);

    // Bars showing impact at each age
    barData.forEach((d) => {
      const barX = x(d.age);
      const barWidth = x.bandwidth();
      const barGroup = g.append("g").attr("class", "bar-group");
      const impact = getImpact(d);

      // Impact bar
      const barHeight = y(0) - y(impact);
      if (barHeight > 0) {
        barGroup.append("rect")
          .attr("x", barX)
          .attr("y", y(impact))
          .attr("width", barWidth)
          .attr("height", barHeight)
          .attr("fill", COLORS.postgradLoan)
          .attr("rx", 2);
      }

      // Invisible overlay for mouse interaction
      barGroup.append("rect")
        .attr("x", barX)
        .attr("y", 0)
        .attr("width", barWidth)
        .attr("height", height)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("mouseover", function(event) {
          barGroup.select("rect:first-child").attr("opacity", 0.8);
          tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
            .html(`<div class="tooltip-title">Age ${d.age} (${d.calendarYear || 2026 + d.year})</div>
              <div class="tooltip-section">
                <div class="tooltip-row"><span>Repayment (frozen)</span><span style="font-weight:600">£${d3.format(",.0f")(d.annualRepaidFrozen || 0)}</span></div>
                <div class="tooltip-row"><span>Repayment (RPI-linked)</span><span style="font-weight:600">£${d3.format(",.0f")(d.annualRepaidIndexed || 0)}</span></div>
              </div>
              <div class="tooltip-row tooltip-total"><span>Annual impact</span><span style="color:${COLORS.postgradLoan};font-weight:700">+£${d3.format(",.0f")(d.annualImpact || 0)}</span></div>
              <div class="tooltip-row"><span>Cumulative impact</span><span style="font-weight:600">+£${d3.format(",.0f")(d.cumulativeImpact || 0)}</span></div>`);
        })
        .on("mouseout", function() {
          barGroup.select("rect:first-child").attr("opacity", 1);
          tooltip.style("opacity", 0);
        });
    });

    // Axes
    const xAxis = d3.axisBottom(x)
      .tickValues(barData.filter(d => d.year % 5 === 0 || d.year === 1 || d.age === maxAge).map(d => d.age))
      .tickFormat(d => `${d}`);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Worker's age");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `£${d3.format(",.0f")(d)}`).ticks(6));
  }, [policyData, paramsLoaded, age, policyChartView]);

  const annualRepayment = withLoan.studentLoan + withLoan.postgradLoan;
  const marginalDiff = (marginalWithLoan.totalRate - marginalWithoutLoan.totalRate) * 100;

  return (
    <div className="narrative-container">
      {/* Hero Section */}
      <header className="narrative-hero">
        <h1>Student loan deductions calculator</h1>
        <p className="narrative-lead">
          Interactive tool to analyse student loan repayments, marginal tax rates, take-home pay, and lifetime costs for UK graduates.
        </p>
      </header>

      {/* Section 1: Overview */}
      <section id="overview" ref={sectionRefs.overview} className="narrative-section">
        <h2>Overview</h2>
        <p>
          This calculator analyses tax deductions for a single adult without children, excluding other forms of benefits or tax credits. It covers marginal deduction rates, tax position breakdowns, take-home pay comparisons, age-based analysis, and lifetime repayment projections.
        </p>
        <p>
          In general, graduates with student loans repay 9% of income above a threshold. In {formatTaxYear(selectedYear)}, these are £{d3.format(",.0f")(params.slPlan1Threshold)} for Plan 1, £{d3.format(",.0f")(params.slPlan2Threshold)} for Plan 2, £{d3.format(",.0f")(params.slPlan4Threshold)} for Plan 4, and £{d3.format(",.0f")(params.slPlan5Threshold)} for Plan 5. These repayments are deducted alongside income tax and National Insurance, raising the marginal rate—the percentage taken from each additional pound earned. A basic rate taxpayer with a student loan faces a 37% marginal rate (compared to 28% without), rising to 51% for higher rate taxpayers (compared to 42%). <details className="expandable-section inline-details">
            <summary>Which plan applies to me?</summary>
            <ul className="plan-list">
              <li><strong>Plan 1:</strong> Started before September 2012 in England or Wales, or studied in Scotland or Northern Ireland. Threshold: £{d3.format(",.0f")(params.slPlan1Threshold)}. Written off after 25 years.</li>
              <li><strong>Plan 2:</strong> Started between September 2012 and July 2023 in England or Wales. Threshold: £{d3.format(",.0f")(params.slPlan2Threshold)}. Written off after 30 years.</li>
              <li><strong>Plan 4:</strong> Scottish students who started after September 1998. Threshold: £{d3.format(",.0f")(params.slPlan4Threshold)}. Written off after 30 years.</li>
              <li><strong>Plan 5:</strong> Started from August 2023 onwards in England. Threshold: £{d3.format(",.0f")(params.slPlan5Threshold)}. Written off after 40 years.</li>
            </ul>
          </details>
        </p>
        <p>
          Additionally, the Autumn Budget 2025 froze Plan 2 thresholds for three years, increasing total repayments for affected borrowers. For detailed policy analysis, see the Autumn Budget 2025 analysis <a href="https://www.policyengine.org/uk/autumn-budget-2025" target="_blank" rel="noopener noreferrer">dashboard</a>.
        </p>
      </section>

      {/* Controls Panel */}
      <p className="controls-intro">Enter borrower details to calculate repayments and deductions:</p>
      <section className="controls-panel">
        <div className="controls-grid">
          <div className="control-item">
            <label>Gross income</label>
            <select
              value={exampleSalary}
              onChange={(e) => setExampleSalary(parseInt(e.target.value))}
              className="salary-select"
            >
              {Array.from({ length: 301 }, (_, i) => i * 500).map((val) => (
                <option key={val} value={val}>£{d3.format(",.0f")(val)}</option>
              ))}
            </select>
          </div>
          <div className="control-item">
            <label>Age</label>
            <input
              type="number"
              value={age}
              onChange={(e) => setAge(Math.min(65, Math.max(18, parseInt(e.target.value) || 22)))}
              min="18"
              max="65"
              className="age-input"
            />
          </div>
          <div className="control-item">
            <label>Loan plan</label>
            <select value={selectedPlan} onChange={(e) => setSelectedPlan(e.target.value)}>
              {PLAN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {selectedPlan !== "none" && (
              <span className="control-hint">{PLAN_OPTIONS.find(p => p.value === selectedPlan)?.description}</span>
            )}
          </div>
          <div className="control-item">
            <label>Tax year</label>
            <select value={selectedYear} onChange={(e) => setSelectedYear(parseInt(e.target.value))}>
              <option value={2026}>2026/27</option>
              <option value={2027}>2027/28</option>
              <option value={2028}>2028/29</option>
              <option value={2029}>2029/30</option>
              <option value={2030}>2030/31</option>
            </select>
          </div>
          <div className="control-item">
            <label className="label-with-info">
              Postgrad
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  <strong>Postgraduate loan</strong>
                  <br />
                  A separate loan for Master's or PhD courses. Repayments are 6% of income above £{d3.format(",.0f")(params.slPostgradThreshold)}, collected alongside undergraduate loan repayments. Both are deducted from the same payslip if the borrower has both loans.
                </span>
              </span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showPostgrad}
                onChange={(e) => setShowPostgrad(e.target.checked)}
              />
              <span>Add 6%</span>
            </label>
            <span className="control-hint">Repays above £{d3.format(",.0f")(params.slPostgradThreshold)}</span>
          </div>
          <div className="control-item">
            <label className="label-with-info">
              Loan balance
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  <strong>Total loan balance</strong>
                  <br />
                  The outstanding balance on the student loan. Used for lifetime analysis calculations.
                </span>
              </span>
            </label>
            <div className="salary-input-wrapper">
              <span className="currency-symbol">£</span>
              <input
                type="number"
                value={loanAmount}
                onChange={(e) => setLoanAmount(Math.max(0, parseInt(e.target.value) || 0))}
                min="0"
                max="200000"
                step="1000"
              />
            </div>
          </div>
          <div className="control-item">
            <label className="label-with-info">
              Salary growth
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  <strong>Annual salary growth</strong>
                  <br />
                  Expected annual percentage increase in salary. Used for lifetime repayment projections. Historical UK average is around 3%.
                </span>
              </span>
            </label>
            <select value={salaryGrowthRate} onChange={(e) => setSalaryGrowthRate(parseFloat(e.target.value))}>
              <option value={0}>0%</option>
              <option value={0.01}>1%</option>
              <option value={0.02}>2%</option>
              <option value={0.03}>3%</option>
              <option value={0.04}>4%</option>
              <option value={0.05}>5%</option>
              <option value={0.06}>6%</option>
              <option value={0.07}>7%</option>
            </select>
          </div>
          <div className="control-item">
            <label className="label-with-info">
              Interest rate
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  <strong>Loan interest rate</strong>
                  <br />
                  Annual interest rate charged on the student loan. Used for lifetime repayment projections.
                </span>
              </span>
            </label>
            <select value={customInterestRate} onChange={(e) => setCustomInterestRate(parseFloat(e.target.value))}>
              <option value={0}>0%</option>
              <option value={0.01}>1%</option>
              <option value={0.02}>2%</option>
              <option value={0.03}>3%</option>
              <option value={0.04}>4%</option>
              <option value={0.05}>5%</option>
              <option value={0.06}>6%</option>
              <option value={0.07}>7%</option>
            </select>
          </div>
        </div>
      </section>

      {/* Chart 1: Marginal Rates */}
      <section id="marginalRates" ref={sectionRefs.marginalRates} className="narrative-section">
        <h2>Marginal deduction rates by income</h2>
        <p>
          The following chart displays the composition of marginal deduction rates across the income distribution.
          The stacked areas show income tax (teal), National Insurance (light teal), and student loan repayments (amber).
          The solid line indicates the total rate with a student loan; the dashed line shows the rate without.
        </p>

        <div className="narrative-chart-container">
          <div ref={chartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.incomeTax }}></div><span>Income tax</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.ni }}></div><span>National Insurance</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan }}></div><span>Student loan</span></div>
            {showPostgrad && <div className="legend-item"><div className="legend-color" style={{ background: COLORS.postgradLoan }}></div><span>Postgrad loan</span></div>}
            <div className="legend-item"><div className="legend-line solid"></div><span>Total rate (with loan)</span></div>
            <div className="legend-item"><div className="legend-line dashed"></div><span>Total rate (no loan)</span></div>
          </div>
        </div>

        <p>
          {hasLoan ? `The student loan repayment band (amber) begins at £${d3.format(",.0f")(planThreshold)}—the ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} threshold. Above this level, each additional pound of earnings incurs the 9% repayment rate alongside income tax and NI. At £${d3.format(",.0f")(exampleSalary)}, a worker with a ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loan faces a marginal rate of ${(marginalWithLoan.totalRate * 100).toFixed(0)}%, compared to ${(marginalWithoutLoan.totalRate * 100).toFixed(0)}% without a loan.` : "Select a student loan plan above to see the impact of repayments on marginal rates."}
        </p>
      </section>

      {/* Combined Tax Position Section */}
      <section id="breakdown" ref={sectionRefs.breakdown} className="narrative-section">
        <h2>Tax position breakdown</h2>
        <p>
          The following table provides a detailed breakdown of deductions and marginal rates for a worker earning £{d3.format(",.0f")(exampleSalary)}, comparing those with a {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label || "student"} loan to those without.
        </p>

        <div className="tax-position-box">
        {/* Marginal Rate Comparison */}
        <div className="marginal-rate-row">
          <div className="marginal-rate-item">
            <div className="marginal-rate-value">{(marginalWithLoan.totalRate * 100).toFixed(0)}%</div>
            <div className="marginal-rate-label">
              Marginal rate (with loan)
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  The percentage taken from each additional pound earned, including income tax, National Insurance, and student loan repayments.
                </span>
              </span>
            </div>
          </div>
          <div className="marginal-rate-item">
            <div className="marginal-rate-value">{(marginalWithoutLoan.totalRate * 100).toFixed(0)}%</div>
            <div className="marginal-rate-label">
              Marginal rate (no loan)
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  The percentage taken from each additional pound earned, including only income tax and National Insurance.
                </span>
              </span>
            </div>
          </div>
          <div className="marginal-rate-item highlight">
            <div className="marginal-rate-value">{hasLoan ? `+${marginalDiff.toFixed(0)}pp` : "—"}</div>
            <div className="marginal-rate-label">
              Difference
              <span className="info-icon-wrapper">
                <span className="info-icon light">i</span>
                <span className="info-tooltip">
                  The additional percentage points (pp) deducted due to student loan repayments. This is the 9% repayment rate applied above the threshold.
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Deductions Breakdown */}
        <div className="deductions-row">
          <div className="deductions-column">
            <h4>With student loan</h4>
            <div className="deduction-item">
              <span>Gross income</span>
              <span>£{d3.format(",.0f")(exampleSalary)}</span>
            </div>
            <div className="deduction-item">
              <span style={{ color: COLORS.incomeTax }}>Income tax</span>
              <span>−£{d3.format(",.0f")(withLoan.incomeTax)}</span>
            </div>
            <div className="deduction-item">
              <span style={{ color: COLORS.ni }}>National Insurance</span>
              <span>−£{d3.format(",.0f")(withLoan.ni)}</span>
            </div>
            {hasLoan && (
              <div className="deduction-item">
                <span style={{ color: COLORS.studentLoan }}>Student loan</span>
                <span>−£{d3.format(",.0f")(withLoan.studentLoan)}</span>
              </div>
            )}
            {showPostgrad && (
              <div className="deduction-item">
                <span style={{ color: COLORS.postgradLoan }}>Postgrad loan</span>
                <span>−£{d3.format(",.0f")(withLoan.postgradLoan)}</span>
              </div>
            )}
            <div className="deduction-item total">
              <span>Total deductions</span>
              <span>−£{d3.format(",.0f")(withLoan.totalDeductions)}</span>
            </div>
            <div className="deduction-item net">
              <span>Net income</span>
              <span className="net-value">£{d3.format(",.0f")(withLoan.netIncome)}</span>
            </div>
          </div>

          <div className="deductions-column">
            <h4>Without student loan</h4>
            <div className="deduction-item">
              <span>Gross income</span>
              <span>£{d3.format(",.0f")(exampleSalary)}</span>
            </div>
            <div className="deduction-item">
              <span style={{ color: COLORS.incomeTax }}>Income tax</span>
              <span>−£{d3.format(",.0f")(withoutLoan.incomeTax)}</span>
            </div>
            <div className="deduction-item">
              <span style={{ color: COLORS.ni }}>National Insurance</span>
              <span>−£{d3.format(",.0f")(withoutLoan.ni)}</span>
            </div>
            <div className="deduction-item total">
              <span>Total deductions</span>
              <span>−£{d3.format(",.0f")(withoutLoan.totalDeductions)}</span>
            </div>
            <div className="deduction-item net">
              <span>Net income</span>
              <span className="net-value">£{d3.format(",.0f")(withoutLoan.netIncome)}</span>
            </div>
          </div>
        </div>

        {/* Summary Stats */}
        {hasLoan && (
          <div className="summary-row">
            <div className="summary-stat">
              <span className="summary-stat-label">
                Annual repayment
                <span className="info-icon-wrapper">
                  <span className="info-icon">i</span>
                  <span className="info-tooltip">
                    Total student loan repayment per year, calculated as 9% of income above the repayment threshold.
                  </span>
                </span>
              </span>
              <span className="summary-stat-value" style={{ color: COLORS.studentLoan }}>£{d3.format(",.0f")(annualRepayment)}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">
                Monthly
                <span className="info-icon-wrapper">
                  <span className="info-icon">i</span>
                  <span className="info-tooltip">
                    Monthly student loan repayment, deducted from wages by the employer through PAYE.
                  </span>
                </span>
              </span>
              <span className="summary-stat-value" style={{ color: COLORS.studentLoan }}>£{d3.format(",.0f")(annualRepayment / 12)}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">
                Effective rate (with)
                <span className="info-icon-wrapper">
                  <span className="info-icon">i</span>
                  <span className="info-tooltip">
                    Total deductions as a percentage of gross income, including income tax, NI, and student loan.
                  </span>
                </span>
              </span>
              <span className="summary-stat-value">{((withLoan.totalDeductions / exampleSalary) * 100).toFixed(1)}%</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">
                Effective rate (without)
                <span className="info-icon-wrapper">
                  <span className="info-icon">i</span>
                  <span className="info-tooltip">
                    Total deductions as a percentage of gross income, including only income tax and NI.
                  </span>
                </span>
              </span>
              <span className="summary-stat-value">{((withoutLoan.totalDeductions / exampleSalary) * 100).toFixed(1)}%</span>
            </div>
          </div>
        )}
        </div>
      </section>

      {/* Section 2: Take-Home Impact */}
      <section id="takeHome" ref={sectionRefs.takeHome} className="narrative-section">
        <h2>Impact on take-home pay</h2>
        <p>
          The following chart compares annual take-home pay for workers with and without student loans across the income distribution. The shaded area highlights the gap between the two scenarios.
        </p>

        <div className="narrative-chart-container">
          <div ref={takeHomeChartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>With student loan</span></div>
          </div>
        </div>

        <p>
          At £{d3.format(",.0f")(exampleSalary)} gross income, {hasLoan ? `a worker with a ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loan receives` : "a worker receives"} <strong>£{d3.format(",.0f")(withLoan.netIncome)}</strong> net
          {hasLoan && <>, compared to <strong>£{d3.format(",.0f")(withoutLoan.netIncome)}</strong> for a worker without a loan—a difference of <strong>£{d3.format(",.0f")(annualRepayment)}</strong> per year</>}. The gap increases with income, as higher earners make larger absolute repayments.
        </p>
      </section>

      {/* Section 3: Age-based comparison */}
      <section id="byAge" ref={sectionRefs.byAge} className="narrative-section">
        <h2>Marginal rate by age group in {formatTaxYear(selectedYear)}</h2>
        <p>
          The following chart compares marginal rates across <strong>different workers of different ages</strong> in {formatTaxYear(selectedYear)}—not
          the same person ageing over time. Workers under {loanCutoffAge} are assumed to still have student loans
          (based on {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label}'s write-off period), whilst older workers have paid off or had their loans written off.
        </p>

        <div className="narrative-chart-container">
          <div ref={ageChartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>Has student loan (under {loanCutoffAge})</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan ({loanCutoffAge}+)</span></div>
          </div>
        </div>

        <p>
          At £{d3.format(",.0f")(exampleSalary)}, workers under {loanCutoffAge} with {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loans face a marginal rate of <strong>{(marginalWithLoan.totalRate * 100).toFixed(0)}%</strong>, whilst those aged {loanCutoffAge} and above (whose loans have been written off) face <strong>{(marginalWithoutLoan.totalRate * 100).toFixed(0)}%</strong>. Student loans are automatically written off after <strong>25 years</strong> for Plan 1, <strong>30 years</strong> for Plans 2 and 4, and <strong>40 years</strong> for Plan 5.
        </p>
      </section>

      {/* Section: Lifetime Loan Analysis */}
      {hasLoan && (
        <section id="lifetime" ref={sectionRefs.lifetime} className="narrative-section">
          <h2>Lifetime repayment analysis</h2>
          <p>
            The following chart projects cumulative repayments and remaining balance over the life of the loan.
            Total repayments depend on salary trajectory, the loan's interest rate, and the write-off period. {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loans are written off after <strong>{getPlanWriteoffYears(params, selectedPlan)} years</strong>.
            This analysis uses the selected age (<strong>{age}</strong>) as the graduation age.
          </p>

          {apiLoading && <div className="api-loading">Loading data from API...</div>}
          {apiError && <div className="api-error">Error: {apiError}</div>}

          <div className="narrative-chart-container">
            <div ref={lifetimeChartRef} className="narrative-chart"></div>
            <div className="chart-legend">
              <div className="legend-item"><div className="legend-color" style={{ background: COLORS.primary }}></div><span>Total repaid</span></div>
              <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan, opacity: 0.7 }}></div><span>Remaining balance</span></div>
            </div>
          </div>

          <p>
            With an original loan of <strong>£{d3.format(",.0f")(loanAmount)}</strong>, a starting salary of{" "}
            <strong>£{d3.format(",.0f")(exampleSalary)}</strong>, and {(salaryGrowthRate * 100).toFixed(0)}% annual salary growth,
            the borrower would repay a total of <strong>£{d3.format(",.0f")(lifetimeData[lifetimeData.length - 1]?.totalRepaid || 0)}</strong> over{" "}
            <strong>{lifetimeData.findIndex(d => d.remainingBalance === 0) > 0
              ? `${lifetimeData.findIndex(d => d.remainingBalance === 0)} years`
              : `${getPlanWriteoffYears(params, selectedPlan)} years (write-off)`}</strong>.{" "}
            {lifetimeData[lifetimeData.length - 1]?.remainingBalance > 0
              ? `The remaining £${d3.format(",.0f")(lifetimeData[lifetimeData.length - 1]?.remainingBalance)} would be written off.`
              : `The loan would be fully repaid before the ${getPlanWriteoffYears(params, selectedPlan)}-year write-off period.`}
          </p>
        </section>
      )}

      <div ref={tooltipRef} className="lifecycle-tooltip"></div>

      {/* Scroll Spy Navigation */}
      <nav className="scroll-spy">
        {sections.map((section) => (
          <button
            key={section.id}
            className={`scroll-spy-item ${activeSection === section.id ? "active" : ""}`}
            onClick={() => {
              document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth" });
            }}
            aria-label={`Go to ${section.label}`}
          >
            <span className="scroll-spy-label">{section.label}</span>
            <span className="scroll-spy-dot" />
          </button>
        ))}
      </nav>
    </div>
  );
}
