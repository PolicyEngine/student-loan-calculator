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
  ucTaper: "#0D9488", // Darker teal for UC taper
  hicbc: "#2DD4BF", // Teal-400 for Child Benefit (HICBC)
  paTaper: "#0F766E", // Teal-700 for Personal Allowance taper
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

// Generate repayment timeline data based on years since graduation
function generateRepaymentTimelineData(salary, params, plan = "plan2", hasPostgrad = false, writeoffYears = 30) {
  const data = [];
  // Show from year 0 (graduation) to writeoff year + a few years after
  const maxYears = writeoffYears + 5;
  for (let year = 0; year <= maxYears; year++) {
    const hasLoan = year < writeoffYears;
    const rate = calculateMarginalRate(salary, params, hasLoan ? plan : "none", hasLoan ? hasPostgrad : false);
    data.push({
      year,
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

// API URL - uses environment variable if set, otherwise production Modal URL
const getApiUrl = () => {
  return import.meta.env.VITE_API_URL || "https://policyengine--student-loan-calculator-api-fastapi-app.modal.run";
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
  const [graduationYear, setGraduationYear] = useState(2026);
  const [loanAmount, setLoanAmount] = useState(40000);
  const [salaryGrowthRate, setSalaryGrowthRate] = useState(0.03);

  // API data state
  const [apiData, setApiData] = useState(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [policyChartView, setPolicyChartView] = useState("annual"); // "annual" or "cumulative"

  // Complete MTR with UC state
  const [numChildren, setNumChildren] = useState(0);
  const [monthlyRent, setMonthlyRent] = useState(1000);
  const [isCouple, setIsCouple] = useState(false);
  const [partnerIncome, setPartnerIncome] = useState(0);
  const [householdExpanded, setHouseholdExpanded] = useState(false);
  const [lifetimeViewMode, setLifetimeViewMode] = useState('cumulative'); // 'cumulative' or 'annual'
  const [completeMtrData, setCompleteMtrData] = useState(null);
  const [completeMtrLoading, setCompleteMtrLoading] = useState(false);
  const [completeMtrError, setCompleteMtrError] = useState(null);

  // Years since graduation (for write-off calculations)
  // Can be negative if graduation year is in the future
  const yearsSinceGraduation = selectedYear - graduationYear;

  // Write-off periods by plan (years after graduation)
  const PLAN_WRITEOFF_YEARS = {
    plan1: 25,
    plan2: 30,
    plan4: 30,
    plan5: 40,
    none: 0,
  };
  const writeoffYears = PLAN_WRITEOFF_YEARS[selectedPlan] || 30;
  const yearsUntilWriteoff = Math.max(0, writeoffYears - yearsSinceGraduation);
  const chartRef = useRef(null);
  const takeHomeChartRef = useRef(null);
  const ageChartRef = useRef(null);
  const lifetimeChartRef = useRef(null);
  const policyChartRef = useRef(null);
  const completeMtrChartRef = useRef(null);
  const tooltipRef = useRef(null);

  // Scroll spy state and refs
  const [activeSection, setActiveSection] = useState("overview");
  const sectionRefs = {
    overview: useRef(null),
    breakdown: useRef(null),
    marginalRates: useRef(null),
    takeHome: useRef(null),
    repaymentTimeline: useRef(null),
    lifetime: useRef(null),
  };

  const sections = [
    { id: "overview", label: "Overview" },
    { id: "marginalRates", label: "MTR" },
    { id: "breakdown", label: "Breakdown" },
    { id: "takeHome", label: "Take-home" },
    { id: "repaymentTimeline", label: "Timeline" },
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
  }, [exampleSalary, loanAmount, selectedPlan, salaryGrowthRate, selectedYear, showPostgrad]);

  // Debounced fetch on input change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchApiData();
    }, 300);
    return () => clearTimeout(timer);
  }, [fetchApiData]);

  // Fetch complete MTR data (with UC) from API
  const fetchCompleteMtrData = useCallback(async () => {
    setCompleteMtrLoading(true);
    setCompleteMtrError(null);

    try {
      // Map plan names to PolicyEngine format
      const planMap = {
        none: "NONE",
        plan1: "PLAN_1",
        plan2: "PLAN_2",
        plan4: "PLAN_4",
        plan5: "PLAN_5",
      };

      const requestBody = {
        year: selectedYear,
        student_loan_plan: planMap[selectedPlan] || "PLAN_2",
        num_children: numChildren,
        monthly_rent: monthlyRent,
        is_couple: isCouple,
        partner_income: isCouple ? partnerIncome : 0,
        has_postgrad: showPostgrad,
        income_max: 150000,
        exact_income: exampleSalary,
      };

      const response = await fetch(`${getApiUrl()}/complete-mtr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      // Debug: Check if HICBC data is in the response
      if (result.mtr_data && result.mtr_data.length > 0) {
        console.log("Sample MTR data point:", result.mtr_data[80]);
        console.log("Has hicbc_marginal_rate:", result.mtr_data[80].hicbc_marginal_rate);
      }
      setCompleteMtrData(result);
    } catch (err) {
      console.error("Error fetching complete MTR data:", err);
      setCompleteMtrError(err.message);
    } finally {
      setCompleteMtrLoading(false);
    }
  }, [selectedYear, selectedPlan, numChildren, monthlyRent, isCouple, partnerIncome, showPostgrad, exampleSalary]);

  // Debounced fetch for complete MTR
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchCompleteMtrData();
    }, 500);
    return () => clearTimeout(timer);
  }, [fetchCompleteMtrData]);

  const params = useMemo(() => {
    if (!paramsLoaded) return DEFAULT_PARAMS;
    return allParams[selectedYear] || DEFAULT_PARAMS;
  }, [allParams, selectedYear, paramsLoaded]);

  const marginalRateData = useMemo(() => generateMarginalRateData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);
  const takeHomeData = useMemo(() => generateTakeHomeData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);
  const repaymentTimelineData = useMemo(() => generateRepaymentTimelineData(exampleSalary, params, selectedPlan, showPostgrad, writeoffYears), [exampleSalary, params, selectedPlan, showPostgrad, writeoffYears]);

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
      .attr("font-size", "12px").attr("fill", "#64748B").text("Marginal tax rate");

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

  // Chart 2: Take-Home Pay (using API data for household)
  useEffect(() => {
    if (!takeHomeChartRef.current || !completeMtrData?.mtr_data?.length) return;

    const container = takeHomeChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const data = completeMtrData.mtr_data;
    const effectivePartnerIncome = isCouple ? partnerIncome : 0;

    // Transform data to include total household income and both scenarios
    // Note: PolicyEngine's household_net_income does NOT include student loan repayments
    // (student loan is debt repayment, not tax), so we subtract it to get true take-home
    const chartData = data.map(d => ({
      totalIncome: d.employment_income + effectivePartnerIncome,
      headIncome: d.employment_income,
      netWithLoan: d.household_net_income - d.student_loan_repayment, // True take-home after loan payment
      netWithoutLoan: d.household_net_income, // No loan = no repayment to make
      studentLoan: d.student_loan_repayment,
      uc: d.universal_credit,
    }));

    const minIncome = effectivePartnerIncome;
    const maxIncome = d3.max(chartData, d => d.totalIncome);

    const x = d3.scaleLinear().domain([minIncome, maxIncome]).range([0, width]);
    const y = d3.scaleLinear().domain([0, d3.max(chartData, d => d.netWithoutLoan) * 1.05]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

    // Gap area between the two lines
    const gapArea = d3.area()
      .x(d => x(d.totalIncome))
      .y0(d => y(d.netWithLoan))
      .y1(d => y(d.netWithoutLoan))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(chartData.filter(d => d.studentLoan > 0))
      .attr("fill", COLORS.studentLoan)
      .attr("fill-opacity", 0.15)
      .attr("d", gapArea);

    // Without loan line
    const lineWithoutLoan = d3.line()
      .x(d => x(d.totalIncome))
      .y(d => y(d.netWithoutLoan))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(chartData)
      .attr("fill", "none")
      .attr("stroke", COLORS.withoutLoan)
      .attr("stroke-width", 2.5)
      .attr("d", lineWithoutLoan);

    // With loan line
    const lineWithLoan = d3.line()
      .x(d => x(d.totalIncome))
      .y(d => y(d.netWithLoan))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(chartData)
      .attr("fill", "none")
      .attr("stroke", COLORS.withLoan)
      .attr("stroke-width", 2.5)
      .attr("d", lineWithLoan);

    // Highlight selected salary
    const totalHouseholdSalary = exampleSalary + effectivePartnerIncome;
    if (totalHouseholdSalary >= minIncome && totalHouseholdSalary <= maxIncome) {
      const closestPoint = chartData.reduce((prev, curr) =>
        Math.abs(curr.totalIncome - totalHouseholdSalary) < Math.abs(prev.totalIncome - totalHouseholdSalary) ? curr : prev
      );

      g.append("line")
        .attr("x1", x(totalHouseholdSalary)).attr("x2", x(totalHouseholdSalary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", COLORS.primary).attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      g.append("circle")
        .attr("cx", x(totalHouseholdSalary)).attr("cy", y(closestPoint.netWithoutLoan)).attr("r", 6)
        .attr("fill", COLORS.withoutLoan).attr("stroke", "#fff").attr("stroke-width", 2);
      g.append("circle")
        .attr("cx", x(totalHouseholdSalary)).attr("cy", y(closestPoint.netWithLoan)).attr("r", 6)
        .attr("fill", COLORS.withLoan).attr("stroke", "#fff").attr("stroke-width", 2);

      const gap = closestPoint.netWithoutLoan - closestPoint.netWithLoan;
      if (gap > 0) {
        g.append("text")
          .attr("x", x(totalHouseholdSalary) + 8).attr("y", 15)
          .attr("font-size", "12px").attr("font-weight", "600").attr("fill", COLORS.studentLoan)
          .text(`-£${d3.format(",.0f")(gap)}/yr`);
      }
    }

    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat(d => `£${d / 1000}k`).ticks(6));
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Total household income");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `£${d / 1000}k`).ticks(6));

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);
    const bisect = d3.bisector(d => d.totalIncome).left;

    g.append("rect").attr("width", width).attr("height", height).attr("fill", "none").attr("pointer-events", "all")
      .on("mousemove", function (event) {
        const [mx] = d3.pointer(event);
        const income = x.invert(mx);
        const i = bisect(chartData, income, 1);
        const d = chartData[Math.min(i, chartData.length - 1)];
        const gap = d.netWithoutLoan - d.netWithLoan;
        const ucRow = d.uc > 0 ? `<div class="tooltip-row"><span style="color:${COLORS.ucTaper}">● UC received</span><span style="font-weight:600">+£${d3.format(",.0f")(d.uc)}</span></div>` : '';
        tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
          .html(`<div class="tooltip-title">£${d3.format(",.0f")(d.totalIncome)} household income</div>
            <div class="tooltip-section">
              <div class="tooltip-row"><span style="color:${COLORS.withoutLoan}">● No loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.netWithoutLoan)}</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.withLoan}">● With loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.netWithLoan)}</span></div>
              ${ucRow}
            </div>
            <div class="tooltip-row tooltip-total"><span>Loan repayment</span><span style="color:${COLORS.studentLoan};font-weight:700">-£${d3.format(",.0f")(gap)}</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [completeMtrData, exampleSalary, isCouple, partnerIncome]);

  // Chart 3: Repayment timeline (stacked bars by years since graduation)
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

    const x = d3.scaleBand().domain(repaymentTimelineData.map((d) => d.year)).range([0, width]).padding(0.15);
    const y = d3.scaleLinear().domain([0, 80]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(8));

    // Reference line at write-off year
    const cutoffX = x(writeoffYears);
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

    // Highlight current position (years since graduation)
    const currentX = x(yearsSinceGraduation);
    if (currentX !== undefined && yearsSinceGraduation >= 0 && yearsSinceGraduation <= writeoffYears + 5) {
      g.append("line")
        .attr("x1", currentX + x.bandwidth() / 2).attr("x2", currentX + x.bandwidth() / 2)
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", COLORS.primary).attr("stroke-width", 2).attr("stroke-dasharray", "4,2");
      g.append("text")
        .attr("x", currentX + x.bandwidth() / 2 + 8).attr("y", 30)
        .attr("font-size", "11px").attr("fill", COLORS.primary).attr("font-weight", "600")
        .text(`You (${selectedYear})`);
    }

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);

    // Stacked bars - draw each component
    repaymentTimelineData.forEach((d) => {
      const isSelected = d.year === yearsSinceGraduation;
      const barX = x(d.year);
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
      const calendarYear = graduationYear + d.year;
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
          const statusText = d.hasLoan ? "Repaying" : "Written off";
          tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
            .html(`<div class="tooltip-title">Year ${d.year} (${calendarYear})</div>
              <div class="tooltip-section">
                <div class="tooltip-row"><span>Status</span><span style="font-weight:600">${statusText}</span></div>
                <div class="tooltip-row"><span style="color:${COLORS.incomeTax}">● Income tax</span><span style="font-weight:600">${d.incomeTax.toFixed(0)}%</span></div>
                <div class="tooltip-row"><span style="color:${COLORS.ni}">● National Insurance</span><span style="font-weight:600">${d.ni.toFixed(0)}%</span></div>
                ${slRow}
                ${postgradRow}
              </div>
              <div class="tooltip-row tooltip-total"><span>Marginal tax rate</span><span style="font-weight:700">${d.totalRate.toFixed(0)}%</span></div>`);
        })
        .on("mouseout", function () {
          barGroup.selectAll("rect:not(:last-child)").attr("opacity", 1);
          tooltip.style("opacity", 0);
        });
    });

    // X-axis with selective labels
    const xAxis = d3.axisBottom(x)
      .tickValues(repaymentTimelineData.filter((d) => d.year % 5 === 0 || d.year === 0 || d.year === writeoffYears).map((d) => d.year))
      .tickFormat((d) => d);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Years since graduation");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat((d) => `${d}%`).ticks(8));
  }, [repaymentTimelineData, paramsLoaded, yearsSinceGraduation, writeoffYears, selectedPlan, selectedYear, graduationYear]);

  // Track previous view mode for animation
  const prevLifetimeViewMode = useRef(lifetimeViewMode);
  const isAnimating = useRef(false);

  // Chart 4: Lifetime Repayment Analysis (stacked bars or annual bars)
  useEffect(() => {
    if (!lifetimeChartRef.current || !paramsLoaded || !lifetimeData.length) return;

    const container = lifetimeChartRef.current;
    const transitionDuration = 400;
    const isViewModeChange = prevLifetimeViewMode.current !== lifetimeViewMode;

    // Function to render the chart
    const renderChart = () => {
      // Clear any existing content before rendering
      container.innerHTML = "";
      d3.select(container).selectAll("*").remove();

      const margin = { top: 20, right: 30, bottom: 50, left: 80 };
      const width = container.clientWidth - margin.left - margin.right;
      const height = 350 - margin.top - margin.bottom;

      const svg = d3.select(container).append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .style("opacity", isViewModeChange ? 0 : 1);

      const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

      // Filter out year 0 for bar chart, add calendar year
      const barData = lifetimeData.filter(d => d.year > 0).map(d => ({
        ...d,
        calendarYear: graduationYear + d.year
      }));
      const maxYear = Math.max(...barData.map(d => d.year));

      // Calculate max value based on view mode
      const maxValue = lifetimeViewMode === 'cumulative'
        ? Math.max(...barData.map(d => d.totalRepaid + d.remainingBalance))
        : Math.max(...barData.map(d => d.annualRepayment));

      const x = d3.scaleBand().domain(barData.map(d => d.year)).range([0, width]).padding(0.15);
      const y = d3.scaleLinear().domain([0, maxValue * 1.1]).range([height, 0]);

      g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

      const tooltip = d3.select(tooltipRef.current);

      if (lifetimeViewMode === 'cumulative') {
        // Stacked bars for cumulative view
        barData.forEach((d) => {
          const barX = x(d.year);
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
              const writeOffRow = d.writeOff > 0 ? `<div class="tooltip-row" style="color:${COLORS.postgradLoan}"><span>● Written off (year ${writeoffYears})</span><span style="font-weight:600">£${d3.format(",.0f")(d.writeOff)}</span></div>` : '';
              tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
                .html(`<div class="tooltip-title">Year ${d.year} (${d.calendarYear})</div>
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
      } else {
        // Annual view - show repayment for each year
        barData.forEach((d) => {
          const barX = x(d.year);
          const barWidth = x.bandwidth();
          const barGroup = g.append("g").attr("class", "bar-group");

          // Annual repayment bar (teal)
          const repaymentHeight = y(0) - y(d.annualRepayment);
          barGroup.append("rect")
            .attr("x", barX)
            .attr("y", y(d.annualRepayment))
            .attr("width", barWidth)
            .attr("height", repaymentHeight)
            .attr("fill", COLORS.primary);

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
              tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
                .html(`<div class="tooltip-title">Year ${d.year} (${d.calendarYear})</div>
                  <div class="tooltip-section">
                    <div class="tooltip-row"><span>Salary</span><span style="font-weight:600">£${d3.format(",.0f")(d.salary)}</span></div>
                  </div>
                  <div class="tooltip-row"><span style="color:${COLORS.primary}">● Annual repayment</span><span style="font-weight:600">£${d3.format(",.0f")(d.annualRepayment)}</span></div>`);
            })
            .on("mouseout", function() {
              barGroup.selectAll("rect:not(:last-child)").attr("opacity", 1);
              tooltip.style("opacity", 0);
            });
        });
      }

      // Axes
      const xAxis = d3.axisBottom(x)
        .tickValues(barData.filter(d => d.year % 5 === 0 || d.year === 1 || d.year === maxYear).map(d => d.year))
        .tickFormat(d => `${d}`);
      g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
      g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
        .attr("font-size", "12px").attr("fill", "#64748B").text("Years since graduation");
      g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `£${d / 1000}k`).ticks(6));
      g.append("text").attr("transform", "rotate(-90)").attr("x", -height / 2).attr("y", -50).attr("text-anchor", "middle")
        .attr("font-size", "12px").attr("fill", "#64748B")
        .text(lifetimeViewMode === 'cumulative' ? "Cumulative amount (£)" : "Annual repayment (£)");

      // Fade in if this was a view mode change
      if (isViewModeChange) {
        svg.transition()
          .duration(transitionDuration)
          .style("opacity", 1);
      }
    };

    // If view mode changed, fade out first then render new chart
    if (isViewModeChange && !isAnimating.current) {
      isAnimating.current = true;
      const existingSvg = d3.select(container).select("svg");

      if (existingSvg.node()) {
        existingSvg.transition()
          .duration(transitionDuration)
          .style("opacity", 0)
          .on("end", () => {
            renderChart();
            prevLifetimeViewMode.current = lifetimeViewMode;
            isAnimating.current = false;
          });
      } else {
        renderChart();
        prevLifetimeViewMode.current = lifetimeViewMode;
        isAnimating.current = false;
      }
    } else if (!isAnimating.current) {
      renderChart();
      prevLifetimeViewMode.current = lifetimeViewMode;
    }
  }, [lifetimeData, paramsLoaded, graduationYear, lifetimeViewMode, writeoffYears]);

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

    // Filter out year 0 and stop at the last year where there's still a balance remaining
    // (i.e., exclude the final payoff year where balance goes to 0)

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
        calendarYear: graduationYear + d.year
      }));

    if (barData.length === 0) return;

    const maxYear = Math.max(...barData.map(d => d.year));
    // Use annual or cumulative based on toggle
    const isCumulative = policyChartView === "cumulative";
    const getImpact = (d) => isCumulative ? (d.cumulativeImpact || 0) : (d.annualImpact || 0);
    const maxImpact = Math.max(...barData.map(d => getImpact(d)), 100);

    const x = d3.scaleBand().domain(barData.map(d => d.year)).range([0, width]).padding(0.15);
    const y = d3.scaleLinear().domain([0, maxImpact * 1.1]).nice().range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(6));

    const tooltip = d3.select(tooltipRef.current);

    // Bars showing impact at each year
    barData.forEach((d) => {
      const barX = x(d.year);
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
            .html(`<div class="tooltip-title">Year ${d.year} (${d.calendarYear})</div>
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
      .tickValues(barData.filter(d => d.year % 5 === 0 || d.year === 1 || d.year === maxYear).map(d => d.year))
      .tickFormat(d => `${d}`);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Years since graduation");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `£${d3.format(",.0f")(d)}`).ticks(6));
  }, [policyData, paramsLoaded, graduationYear, policyChartView]);

  // Chart 7: Complete MTR with Universal Credit
  useEffect(() => {
    if (!completeMtrChartRef.current || !completeMtrData?.mtr_data?.length) return;

    const container = completeMtrChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const svg = d3.select(container)
      .append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const data = completeMtrData.mtr_data;
    // Add partner income to get total household income for x-axis
    const effectivePartnerIncome = isCouple ? partnerIncome : 0;
    const minIncome = effectivePartnerIncome; // Starts at partner income (or 0 if single)
    const maxIncome = d3.max(data, d => d.employment_income) + effectivePartnerIncome;

    const x = d3.scaleLinear().domain([minIncome, maxIncome]).range([0, width]);

    // Helper to get total household income from head's income
    const getHouseholdIncome = (headIncome) => headIncome + effectivePartnerIncome;
    const y = d3.scaleLinear().domain([0, 100]).range([height, 0]);

    // Grid
    g.append("g").attr("class", "grid")
      .call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(10));

    // Stacked areas for each component (x uses total household income)
    // Order: Income tax -> PA taper -> HICBC -> NI -> Student loan -> Postgrad -> UC taper
    const areaIT = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(y(0))
      .y1(d => y(d.income_tax_marginal_rate * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.incomeTax)
      .attr("fill-opacity", 0.7)
      .attr("d", areaIT);

    // PA taper (Personal Allowance taper) area
    const areaPATaper = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(d => y(d.income_tax_marginal_rate * 100))
      .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0)) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.paTaper)
      .attr("fill-opacity", 0.7)
      .attr("d", areaPATaper);

    // HICBC (Child Benefit) area
    const areaHICBC = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0)) * 100))
      .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0)) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.hicbc)
      .attr("fill-opacity", 0.7)
      .attr("d", areaHICBC);

    const areaNI = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0)) * 100))
      .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.ni)
      .attr("fill-opacity", 0.7)
      .attr("d", areaNI);

    const areaSL = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate) * 100))
      .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.studentLoan)
      .attr("fill-opacity", 0.7)
      .attr("d", areaSL);

    // Postgrad loan area (only if showPostgrad is true)
    if (showPostgrad) {
      const areaPG = d3.area()
        .x(d => x(getHouseholdIncome(d.employment_income)))
        .y0(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate) * 100))
        .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate + (d.postgrad_marginal_rate || 0)) * 100))
        .curve(d3.curveStepAfter);

      g.append("path")
        .datum(data)
        .attr("fill", COLORS.postgradLoan)
        .attr("fill-opacity", 0.7)
        .attr("d", areaPG);
    }

    // UC taper area (shown in different color from postgrad)
    const areaUC = d3.area()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y0(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate + (showPostgrad ? (d.postgrad_marginal_rate || 0) : 0)) * 100))
      .y1(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate + (showPostgrad ? (d.postgrad_marginal_rate || 0) : 0) + d.uc_marginal_rate) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", COLORS.ucTaper)
      .attr("fill-opacity", 0.7)
      .attr("d", areaUC);

    // Marginal tax rate line (with loan) - sum of all components
    const lineTotal = d3.line()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y(d => y((d.income_tax_marginal_rate + (d.pa_taper_marginal_rate || 0) + (d.hicbc_marginal_rate || 0) + d.ni_marginal_rate + d.student_loan_marginal_rate + (showPostgrad ? (d.postgrad_marginal_rate || 0) : 0) + d.uc_marginal_rate) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 1.5)
      .attr("d", lineTotal);

    // Marginal tax rate line (without loan) - sum without student loan and postgrad
    const lineTotalNoLoan = d3.line()
      .x(d => x(getHouseholdIncome(d.employment_income)))
      .y(d => y((d.income_tax_marginal_rate + (d.hicbc_marginal_rate || 0) + (d.pa_taper_marginal_rate || 0) + d.ni_marginal_rate + d.uc_marginal_rate) * 100))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "6,3")
      .attr("d", lineTotalNoLoan);

    // Highlight selected salary with vertical line (using total household income)
    const totalHouseholdSalary = exampleSalary + effectivePartnerIncome;
    if (totalHouseholdSalary > 0 && totalHouseholdSalary <= maxIncome) {
      const closestPoint = data.reduce((prev, curr) =>
        Math.abs(curr.employment_income - exampleSalary) < Math.abs(prev.employment_income - exampleSalary) ? curr : prev
      );

      g.append("line")
        .attr("x1", x(totalHouseholdSalary)).attr("x2", x(totalHouseholdSalary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", COLORS.primary).attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      const postgradRate = showPostgrad ? (closestPoint.postgrad_marginal_rate || 0) : 0;
      const hicbcRate = closestPoint.hicbc_marginal_rate || 0;
      const paTaperRate = closestPoint.pa_taper_marginal_rate || 0;
      const totalWithLoan = (closestPoint.income_tax_marginal_rate + hicbcRate + paTaperRate + closestPoint.ni_marginal_rate + closestPoint.student_loan_marginal_rate + postgradRate + closestPoint.uc_marginal_rate) * 100;

      g.append("circle")
        .attr("cx", x(totalHouseholdSalary))
        .attr("cy", y(totalWithLoan))
        .attr("r", 6)
        .attr("fill", "#344054").attr("stroke", "#fff").attr("stroke-width", 2);

      // Label showing total rate
      g.append("text")
        .attr("x", x(totalHouseholdSalary) + 8).attr("y", 15)
        .attr("font-size", "12px").attr("font-weight", "600").attr("fill", COLORS.ucTaper)
        .text(`${totalWithLoan.toFixed(0)}%`);
    }

    // Axes
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).tickFormat(d => `£${d / 1000}k`).ticks(8));
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Total household head employment income");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat(d => `${d}%`).ticks(10));
    g.append("text").attr("transform", "rotate(-90)").attr("x", -height / 2).attr("y", -50).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Marginal tax rate");

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);
    const bisect = d3.bisector(d => getHouseholdIncome(d.employment_income)).left;

    g.append("rect").attr("width", width).attr("height", height).attr("fill", "none").attr("pointer-events", "all")
      .on("mousemove", function (event) {
        const [mx] = d3.pointer(event);
        const totalIncome = x.invert(mx);
        const i = bisect(data, totalIncome, 1);
        const d = data[Math.min(i, data.length - 1)];
        const householdTotal = getHouseholdIncome(d.employment_income);
        const postgradRate = showPostgrad ? (d.postgrad_marginal_rate || 0) : 0;
        const hicbcRate = d.hicbc_marginal_rate || 0;
        const paTaperRate = d.pa_taper_marginal_rate || 0;
        const totalRate = (d.income_tax_marginal_rate + hicbcRate + paTaperRate + d.ni_marginal_rate + d.student_loan_marginal_rate + postgradRate + d.uc_marginal_rate) * 100;
        const ucRow = d.uc_marginal_rate > 0.01 ? `<div class="tooltip-row"><span style="color:${COLORS.ucTaper}">● UC taper</span><span style="font-weight:600">${(d.uc_marginal_rate * 100).toFixed(0)}%</span></div>` : '';
        const pgRow = showPostgrad && postgradRate > 0.01 ? `<div class="tooltip-row"><span style="color:${COLORS.postgradLoan}">● Postgrad loan</span><span style="font-weight:600">${(postgradRate * 100).toFixed(0)}%</span></div>` : '';
        const slRow = d.student_loan_marginal_rate > 0.01 ? `<div class="tooltip-row"><span style="color:${COLORS.studentLoan}">● Student loan</span><span style="font-weight:600">${(d.student_loan_marginal_rate * 100).toFixed(0)}%</span></div>` : '';
        const hicbcRow = hicbcRate > 0.01 ? `<div class="tooltip-row"><span style="color:${COLORS.hicbc}">● Child Benefit clawback</span><span style="font-weight:600">${(hicbcRate * 100).toFixed(0)}%</span></div>` : '';
        const paTaperRow = paTaperRate > 0.01 ? `<div class="tooltip-row"><span style="color:${COLORS.paTaper}">● PA taper</span><span style="font-weight:600">${(paTaperRate * 100).toFixed(0)}%</span></div>` : '';
        tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
          .html(`<div class="tooltip-title">Household income: £${d3.format(",.0f")(householdTotal)}</div>
            <div class="tooltip-section">
              <div class="tooltip-row"><span style="color:${COLORS.incomeTax}">● Income tax</span><span style="font-weight:600">${(d.income_tax_marginal_rate * 100).toFixed(0)}%</span></div>
              ${hicbcRow}
              ${paTaperRow}
              <div class="tooltip-row"><span style="color:${COLORS.ni}">● National Insurance</span><span style="font-weight:600">${(d.ni_marginal_rate * 100).toFixed(0)}%</span></div>
              ${slRow}
              ${pgRow}
              ${ucRow}
            </div>
            <div class="tooltip-row tooltip-total"><span>Marginal tax rate</span><span style="font-weight:700">${totalRate.toFixed(0)}%</span></div>
            <div class="tooltip-row"><span>Net income</span><span style="font-weight:600">£${d3.format(",.0f")(d.household_net_income - d.student_loan_repayment)}</span></div>
            <div class="tooltip-row"><span>UC received</span><span style="font-weight:600">£${d3.format(",.0f")(d.universal_credit)}</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [completeMtrData, exampleSalary, showPostgrad, isCouple, partnerIncome]);

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
          This calculator analyses tax deductions for households, including Universal Credit where applicable. It covers marginal tax rates, tax position breakdowns, take-home pay comparisons, repayment timeline analysis, and lifetime repayment projections. Use the household information controls to adjust for couples, partner income, rent, and children.
        </p>
        <p>
          In general, graduates with student loans repay 9% of income above a threshold. In {formatTaxYear(selectedYear)}, these are £{d3.format(",.0f")(params.slPlan1Threshold)} for Plan 1, £{d3.format(",.0f")(params.slPlan2Threshold)} for Plan 2, £{d3.format(",.0f")(params.slPlan4Threshold)} for Plan 4, and £{d3.format(",.0f")(params.slPlan5Threshold)} for Plan 5. These repayments are deducted alongside income tax and National Insurance, raising the marginal rate—the percentage taken from each additional pound earned. A basic rate taxpayer with a student loan faces a 37% marginal rate (compared to 28% without), rising to 51% for higher rate taxpayers (compared to 42%). <details className="expandable-section inline-details">
            <summary>Which plan applies to me?</summary>
            <ul className="plan-list">
              <li><a href="https://www.gov.uk/guidance/how-interest-is-calculated-plan-1" target="_blank" rel="noopener noreferrer">Plan 1</a> applies to borrowers who started before September 2012 in England or Wales, or who studied in Scotland or Northern Ireland. The repayment threshold is £{d3.format(",.0f")(params.slPlan1Threshold)}, and interest is charged at RPI or the Bank of England base rate plus 1%, whichever is lower. The loan is written off after 25 years.</li>
              <li><a href="https://www.gov.uk/guidance/how-interest-is-calculated-plan-2" target="_blank" rel="noopener noreferrer">Plan 2</a> applies to borrowers who started between September 2012 and July 2023 in England or Wales. The repayment threshold is £{d3.format(",.0f")(params.slPlan2Threshold)}. Interest is charged at RPI while studying, and after graduation it ranges from RPI to RPI plus 3% depending on income. The loan is written off after 30 years.</li>
              <li><a href="https://www.gov.uk/guidance/how-interest-is-calculated-plan-4" target="_blank" rel="noopener noreferrer">Plan 4</a> applies to Scottish students who started after September 1998. The repayment threshold is £{d3.format(",.0f")(params.slPlan4Threshold)}, and interest is charged at RPI or the Bank of England base rate plus 1%, whichever is lower. The loan is written off after 30 years.</li>
              <li><a href="https://www.gov.uk/guidance/how-interest-is-calculated-plan-5" target="_blank" rel="noopener noreferrer">Plan 5</a> applies to borrowers who started from August 2023 onwards in England. The repayment threshold is £{d3.format(",.0f")(params.slPlan5Threshold)}, and interest is charged at RPI only. The loan is written off after 40 years.</li>
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
            <label className="label-with-info">
              Graduation year
              <span className="info-icon-wrapper">
                <span className="info-icon">i</span>
                <span className="info-tooltip">
                  <strong>Year of graduation</strong>
                  <br />
                  The year you finished your course. This determines how many years you have been repaying and when your loan will be written off.
                </span>
              </span>
            </label>
            <select
              value={graduationYear}
              onChange={(e) => setGraduationYear(parseInt(e.target.value))}
              className="graduation-year-select"
            >
              {Array.from({ length: 36 }, (_, i) => 2000 + i).map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
            <span className="control-hint">
              {yearsSinceGraduation === 0
                ? 'Graduating this year'
                : yearsSinceGraduation > 0
                  ? `${yearsSinceGraduation} ${yearsSinceGraduation === 1 ? 'year' : 'years'} since graduation`
                  : `${Math.abs(yearsSinceGraduation)} ${Math.abs(yearsSinceGraduation) === 1 ? 'year' : 'years'} until graduation`
              }
            </span>
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
        </div>

        {/* Expandable Household Information */}
        <div className="household-expand-section">
          <button
            className="household-expand-button"
            onClick={() => setHouseholdExpanded(!householdExpanded)}
          >
            <span>Enter household composition (for benefits calculation)</span>
            <span className={`expand-arrow ${householdExpanded ? 'expanded' : ''}`}>▼</span>
          </button>

          {householdExpanded && (
            <div className="household-controls-expanded">
              <div className="control-item">
                <label className="label-with-info">
                  Living situation
                  <span className="info-icon-wrapper">
                    <span className="info-icon">i</span>
                    <span className="info-tooltip">
                      <strong>Living situation</strong>
                      <br />
                      Whether you live alone or with a partner. Affects UC eligibility and taper rates.
                    </span>
                  </span>
                </label>
                <select value={isCouple ? "couple" : "single"} onChange={(e) => setIsCouple(e.target.value === "couple")}>
                  <option value="single">Single</option>
                  <option value="couple">Couple</option>
                </select>
              </div>
              {isCouple && (
                <div className="control-item">
                  <label className="label-with-info">
                    Partner income
                    <span className="info-icon-wrapper">
                      <span className="info-icon">i</span>
                      <span className="info-tooltip">
                        <strong>Partner's annual income</strong>
                        <br />
                        Partner's employment income affects household UC entitlement.
                      </span>
                    </span>
                  </label>
                  <select value={partnerIncome} onChange={(e) => setPartnerIncome(parseInt(e.target.value))}>
                    {Array.from({ length: 301 }, (_, i) => i * 500).map((val) => (
                      <option key={val} value={val}>
                        {val === 0 ? '£0 (not working)' : `£${d3.format(",.0f")(val)}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="control-item">
                <label className="label-with-info">
                  Children
                  <span className="info-icon-wrapper">
                    <span className="info-icon">i</span>
                    <span className="info-tooltip">
                      <strong>Dependent children</strong>
                      <br />
                      Number of children affects UC child element and work allowance.
                    </span>
                  </span>
                </label>
                <select value={numChildren} onChange={(e) => setNumChildren(parseInt(e.target.value))}>
                  {Array.from({ length: 7 }, (_, i) => i).map(value => (
                    <option key={value} value={value}>
                      {value === 0 ? '0' : value === 1 ? '1 child' : `${value} children`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control-item">
                <label className="label-with-info">
                  Monthly rent
                  <span className="info-icon-wrapper">
                    <span className="info-icon">i</span>
                    <span className="info-tooltip">
                      <strong>Housing costs</strong>
                      <br />
                      Monthly rent affects UC housing element eligibility.
                    </span>
                  </span>
                </label>
                <select value={monthlyRent} onChange={(e) => setMonthlyRent(parseInt(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => i * 100).map(value => (
                    <option key={value} value={value}>
                      {value === 0 ? '£0 (no rent)' : `£${d3.format(",")(value)}/month`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Key Summary Box */}
      {hasLoan && (
        <section className="summary-section">
          <h2>Loan summary</h2>
          {completeMtrLoading ? (
            <div className="api-loading">Calculating loan summary...</div>
          ) : completeMtrData && completeMtrData.mtr_data && (() => {
            const data = completeMtrData.mtr_data;
            const exactMatch = data.find(d => d.employment_income === exampleSalary);
            const closestPoint = exactMatch || data.reduce((prev, curr) =>
              Math.abs(curr.employment_income - exampleSalary) < Math.abs(prev.employment_income - exampleSalary) ? curr : prev
            );
            const postgradRate = showPostgrad ? (closestPoint.postgrad_marginal_rate || 0) : 0;
            const hicbcRate = closestPoint.hicbc_marginal_rate || 0;
            const paTaperRate = closestPoint.pa_taper_marginal_rate || 0;
            const rateWithLoan = (closestPoint.income_tax_marginal_rate + paTaperRate + hicbcRate + closestPoint.ni_marginal_rate + closestPoint.student_loan_marginal_rate + postgradRate + closestPoint.uc_marginal_rate) * 100;
            const rateWithoutLoan = (closestPoint.income_tax_marginal_rate + paTaperRate + hicbcRate + closestPoint.ni_marginal_rate + closestPoint.uc_marginal_rate) * 100;
            const difference = rateWithLoan - rateWithoutLoan;

            // Calculate payoff projection
            const yearsToPayoff = lifetimeData.findIndex(d => d.remainingBalance === 0);
            const willPayOff = yearsToPayoff > 0;
            const remainingAtWriteoff = lifetimeData[lifetimeData.length - 1]?.remainingBalance || 0;

            // Get annual repayment range and average from lifetime data
            const repayments = lifetimeData.filter(d => d.annualRepayment > 0).map(d => d.annualRepayment);
            const minRepayment = repayments.length > 0 ? Math.min(...repayments) : 0;
            const maxRepayment = repayments.length > 0 ? Math.max(...repayments) : 0;
            const avgRepayment = repayments.length > 0 ? repayments.reduce((a, b) => a + b, 0) / repayments.length : 0;

            return (
              <div className="summary-cards">
                <div className="summary-card">
                  <div className="summary-number">£{d3.format(",.0f")(avgRepayment)}</div>
                  <div className="summary-label">Average annual repayment</div>
                  <div className="summary-sublabel">range: £{d3.format(",.0f")(minRepayment)} to £{d3.format(",.0f")(maxRepayment)}</div>
                </div>
                <div className="summary-card">
                  {willPayOff ? (
                    <>
                      <div className="summary-number">{yearsToPayoff} years</div>
                      <div className="summary-label">To pay off loan</div>
                    </>
                  ) : (
                    <>
                      <div className="summary-number">£{d3.format(",.0f")(remainingAtWriteoff)}</div>
                      <div className="summary-label">Written off</div>
                      <div className="summary-sublabel">after {writeoffYears} years</div>
                    </>
                  )}
                </div>
                <div className="summary-card highlight-card">
                  <div className="summary-number">{rateWithLoan.toFixed(0)}%</div>
                  <div className="summary-label">Marginal tax rate</div>
                  <div className="summary-sublabel">(+{difference.toFixed(0)}pp from student loan)</div>
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {/* Section: Marginal Tax Rates */}
      <section id="marginalRates" ref={sectionRefs.marginalRates} className="narrative-section">
        <h2>Marginal tax rates by income</h2>
        <p>
          The following chart displays the composition of marginal tax rates across the income distribution.
          Income tax applies at 20% (basic rate), 40% (higher rate), and 45% (additional rate above £125,140).
          The Personal Allowance taper adds 20% between £100,000-£125,140. Child Benefit clawback adds ~7% per child between £60,000-£80,000.
          National Insurance is 8% up to the upper earnings limit, then 2%. Student loan repayments are 9% above the plan threshold.
          For households receiving Universal Credit, the UC taper withdraws benefits at 55% as income rises.
          For couples, partner income is assumed fixed while the household head's income varies.
          Use the household information controls above to adjust the household composition.
        </p>

        {completeMtrError && <div className="api-error">Error: {completeMtrError}</div>}

        {completeMtrLoading ? (
          <div className="api-loading">Calculating complete marginal rates...</div>
        ) : completeMtrData && (
          <>
            <div className="narrative-chart-container">
              <div ref={completeMtrChartRef} className="narrative-chart"></div>
              <div className="chart-legend">
                <div className="legend-item"><div className="legend-color" style={{ background: COLORS.incomeTax }}></div><span>Income tax</span></div>
                <div className="legend-item">
                  <div className="legend-color" style={{ background: COLORS.hicbc }}></div>
                  <span className="label-with-info">
                    Child Benefit clawback
                    <span className="info-icon-wrapper">
                      <span className="info-icon">i</span>
                      <span className="info-tooltip">
                        <strong>High Income Child Benefit Charge (HICBC)</strong>
                        <br />
                        If you earn over £60,000, you must repay 1% of Child Benefit for every £200 above this threshold. At £80,000+, all Child Benefit is clawed back. This creates an effective ~7% marginal rate per child (e.g. ~7% for 1 child, ~12% for 2 children).
                      </span>
                    </span>
                  </span>
                </div>
                <div className="legend-item">
                  <div className="legend-color" style={{ background: COLORS.paTaper }}></div>
                  <span className="label-with-info">
                    PA taper
                    <span className="info-icon-wrapper">
                      <span className="info-icon">i</span>
                      <span className="info-tooltip">
                        <strong>Personal Allowance Taper</strong>
                        <br />
                        For income over £100,000, the £12,570 Personal Allowance is reduced by £1 for every £2 earned above this threshold. This creates an effective 60% marginal tax rate (40% higher rate + 20% from losing allowance) until the allowance is fully withdrawn at £125,140.
                      </span>
                    </span>
                  </span>
                </div>
                <div className="legend-item"><div className="legend-color" style={{ background: COLORS.ni }}></div><span>National Insurance</span></div>
                <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan }}></div><span>Student loan</span></div>
                {showPostgrad && <div className="legend-item"><div className="legend-color" style={{ background: COLORS.postgradLoan }}></div><span>Postgrad loan</span></div>}
                <div className="legend-item"><div className="legend-color" style={{ background: COLORS.ucTaper }}></div><span>UC taper</span></div>
                <div className="legend-item"><div className="legend-line solid"></div><span>Total rate (with loan)</span></div>
                <div className="legend-item"><div className="legend-line dashed"></div><span>Total rate (no loan)</span></div>
              </div>
            </div>

            {(() => {
              // Show MTR breakdown at user's selected income
              const data = completeMtrData.mtr_data;
              const effectivePartnerIncome = isCouple ? partnerIncome : 0;
              const closestPoint = data.reduce((prev, curr) =>
                Math.abs(curr.employment_income - exampleSalary) < Math.abs(prev.employment_income - exampleSalary) ? curr : prev
              );
              const postgradRate = showPostgrad ? (closestPoint.postgrad_marginal_rate || 0) : 0;
              const hicbcRate = closestPoint.hicbc_marginal_rate || 0;
              const paTaperRate = closestPoint.pa_taper_marginal_rate || 0;
              const totalRate = (closestPoint.income_tax_marginal_rate + paTaperRate + hicbcRate + closestPoint.ni_marginal_rate + closestPoint.student_loan_marginal_rate + postgradRate + closestPoint.uc_marginal_rate) * 100;
              const totalHouseholdIncome = exampleSalary + effectivePartnerIncome;
              const hasUC = closestPoint.uc_marginal_rate > 0.01;
              const rateBreakdown = [
                `${(closestPoint.income_tax_marginal_rate * 100).toFixed(0)}% income tax`,
                paTaperRate > 0.01 ? `${(paTaperRate * 100).toFixed(0)}% PA taper` : null,
                hicbcRate > 0.01 ? `${(hicbcRate * 100).toFixed(0)}% Child Benefit` : null,
                `${(closestPoint.ni_marginal_rate * 100).toFixed(0)}% National Insurance`,
                closestPoint.student_loan_marginal_rate > 0.01 ? `${(closestPoint.student_loan_marginal_rate * 100).toFixed(0)}% student loan` : null,
                showPostgrad && postgradRate > 0.01 ? `${(postgradRate * 100).toFixed(0)}% postgrad loan` : null,
                hasUC ? `${(closestPoint.uc_marginal_rate * 100).toFixed(0)}% UC taper` : null,
              ].filter(Boolean).join(', ');
              return (
                <p>
                  At £{d3.format(",.0f")(totalHouseholdIncome)} total household income, the marginal tax rate is <strong>{totalRate.toFixed(0)}%</strong> ({rateBreakdown}).
                </p>
              );
            })()}
          </>
        )}
      </section>

      {/* Combined Tax Position Section */}
      <section id="breakdown" ref={sectionRefs.breakdown} className="narrative-section">
        <h2>Tax position breakdown</h2>
        {completeMtrLoading ? (
          <div className="api-loading">Loading tax position data...</div>
        ) : completeMtrData && completeMtrData.mtr_data && (() => {
          // Find exact match or closest data point to exampleSalary
          const data = completeMtrData.mtr_data;
          const exactMatch = data.find(d => d.employment_income === exampleSalary);
          const closestPoint = exactMatch || data.reduce((prev, curr) =>
            Math.abs(curr.employment_income - exampleSalary) < Math.abs(prev.employment_income - exampleSalary) ? curr : prev
          );
          const effectivePartnerIncome = isCouple ? partnerIncome : 0;
          const totalHouseholdIncome = exampleSalary + effectivePartnerIncome;
          const postgradRate = showPostgrad ? (closestPoint.postgrad_marginal_rate || 0) : 0;
          const hicbcRate = closestPoint.hicbc_marginal_rate || 0;
          const paTaperRate = closestPoint.pa_taper_marginal_rate || 0;
          const totalMarginalWithLoan = (closestPoint.income_tax_marginal_rate + hicbcRate + paTaperRate + closestPoint.ni_marginal_rate + closestPoint.student_loan_marginal_rate + postgradRate + closestPoint.uc_marginal_rate) * 100;
          const totalMarginalNoLoan = (closestPoint.income_tax_marginal_rate + hicbcRate + paTaperRate + closestPoint.ni_marginal_rate + closestPoint.uc_marginal_rate) * 100;
          const marginalDiff = totalMarginalWithLoan - totalMarginalNoLoan;

          return (
            <>
              <p>
                The following table provides a detailed breakdown for the household head earning £{d3.format(",.0f")(exampleSalary)} (total household income: £{d3.format(",.0f")(totalHouseholdIncome)}).
              </p>

              <div className="tax-position-box">
                {/* Marginal Rate Comparison */}
                <div className="marginal-rate-row">
                  <div className="marginal-rate-item">
                    <div className="marginal-rate-value">{totalMarginalWithLoan.toFixed(0)}%</div>
                    <div className="marginal-rate-label">Marginal rate (with loan)</div>
                  </div>
                  <div className="marginal-rate-item">
                    <div className="marginal-rate-value">{totalMarginalNoLoan.toFixed(0)}%</div>
                    <div className="marginal-rate-label">Marginal rate (no loan)</div>
                  </div>
                  <div className="marginal-rate-item highlight">
                    <div className="marginal-rate-value">{marginalDiff > 0 ? `+${marginalDiff.toFixed(0)}pp` : "—"}</div>
                    <div className="marginal-rate-label">Difference due to loan</div>
                  </div>
                </div>

                {/* Deductions Breakdown */}
                <div className="deductions-row">
                  <div className="deductions-column">
                    <h4>Annual amounts</h4>
                    <div className="deduction-item">
                      <span>Gross income (head)</span>
                      <span>£{d3.format(",.0f")(exampleSalary)}</span>
                    </div>
                    {isCouple && effectivePartnerIncome > 0 && (
                      <div className="deduction-item">
                        <span>Gross income (partner)</span>
                        <span>£{d3.format(",.0f")(effectivePartnerIncome)}</span>
                      </div>
                    )}
                    {(() => {
                      // Calculate PA taper amount (extra tax from losing Personal Allowance)
                      // PA taper: £100k-£125,140, lose £1 PA for every £2 over £100k
                      const paStart = 100000;
                      const paEnd = 125140;
                      const personalAllowance = 12570;
                      const headIncome = exampleSalary;
                      let paTaperAmount = 0;
                      if (headIncome > paStart) {
                        const paLost = Math.min((headIncome - paStart) / 2, personalAllowance);
                        paTaperAmount = paLost * 0.40; // Extra tax at 40% higher rate
                      }
                      const incomeTaxWithoutPaTaper = closestPoint.income_tax - paTaperAmount;
                      return (
                        <>
                          <div className="deduction-item">
                            <span style={{ color: COLORS.incomeTax }}>Income tax{isCouple ? ' (household)' : ''}</span>
                            <span>−£{d3.format(",.0f")(incomeTaxWithoutPaTaper)}</span>
                          </div>
                          {paTaperAmount > 0 && (
                            <div className="deduction-item">
                              <span style={{ color: COLORS.paTaper }}>PA taper{isCouple ? ' (head)' : ''}</span>
                              <span>−£{d3.format(",.0f")(paTaperAmount)}</span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                    <div className="deduction-item">
                      <span style={{ color: COLORS.ni }}>National Insurance{isCouple ? ' (household)' : ''}</span>
                      <span>−£{d3.format(",.0f")(closestPoint.national_insurance)}</span>
                    </div>
                    {closestPoint.student_loan_repayment > 0 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.studentLoan }}>Student loan{isCouple ? ' (head)' : ''}</span>
                        <span>−£{d3.format(",.0f")(closestPoint.student_loan_repayment)}</span>
                      </div>
                    )}
                    {closestPoint.universal_credit > 0 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.primary }}>Universal Credit (household)</span>
                        <span>+£{d3.format(",.0f")(closestPoint.universal_credit)}</span>
                      </div>
                    )}
                    {closestPoint.child_benefit > 0 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.hicbc }}>Child Benefit (household)</span>
                        <span>+£{d3.format(",.0f")(closestPoint.child_benefit)}</span>
                      </div>
                    )}
                    {closestPoint.tv_licence > 0 && (
                      <div className="deduction-item">
                        <span>TV licence (household)</span>
                        <span>−£{d3.format(",.0f")(closestPoint.tv_licence)}</span>
                      </div>
                    )}
                    <div className="deduction-item net">
                      <span>Household net income</span>
                      <span className="net-value">£{d3.format(",.0f")(closestPoint.household_net_income - closestPoint.student_loan_repayment)}</span>
                    </div>
                  </div>

                  <div className="deductions-column">
                    <h4>Marginal rates breakdown</h4>
                    <div className="deduction-item">
                      <span style={{ color: COLORS.incomeTax }}>Income tax</span>
                      <span>{(closestPoint.income_tax_marginal_rate * 100).toFixed(0)}%</span>
                    </div>
                    {(closestPoint.hicbc_marginal_rate || 0) > 0.01 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.hicbc }}>Child Benefit clawback</span>
                        <span>{((closestPoint.hicbc_marginal_rate || 0) * 100).toFixed(0)}%</span>
                      </div>
                    )}
                    {paTaperRate > 0.01 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.paTaper }}>PA taper</span>
                        <span>{(paTaperRate * 100).toFixed(0)}%</span>
                      </div>
                    )}
                    <div className="deduction-item">
                      <span style={{ color: COLORS.ni }}>National Insurance</span>
                      <span>{(closestPoint.ni_marginal_rate * 100).toFixed(0)}%</span>
                    </div>
                    {closestPoint.student_loan_marginal_rate > 0.01 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.studentLoan }}>Student loan</span>
                        <span>{(closestPoint.student_loan_marginal_rate * 100).toFixed(0)}%</span>
                      </div>
                    )}
                    {showPostgrad && postgradRate > 0.01 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.postgradLoan }}>Postgrad loan</span>
                        <span>{(postgradRate * 100).toFixed(0)}%</span>
                      </div>
                    )}
                    {closestPoint.uc_marginal_rate > 0.01 && (
                      <div className="deduction-item">
                        <span style={{ color: COLORS.ucTaper }}>UC taper</span>
                        <span>{(closestPoint.uc_marginal_rate * 100).toFixed(0)}%</span>
                      </div>
                    )}
                    <div className="deduction-item total">
                      <span>Marginal tax rate</span>
                      <span>{totalMarginalWithLoan.toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        })()}
      </section>

      {/* Section 2: Take-Home Impact */}
      <section id="takeHome" ref={sectionRefs.takeHome} className="narrative-section">
        <h2>Impact on take-home pay</h2>
        <p>
          The following chart compares annual household net income across the income distribution, showing the impact of student loan repayments. For couples, partner income is assumed fixed while the household head's income varies.
        </p>

        {completeMtrLoading ? (
          <div className="api-loading">Loading take-home data...</div>
        ) : completeMtrData && completeMtrData.mtr_data && (() => {
          const data = completeMtrData.mtr_data;
          const effectivePartnerIncome = isCouple ? partnerIncome : 0;

          // Find closest point to exampleSalary
          const closestPoint = data.reduce((prev, curr) =>
            Math.abs(curr.employment_income - exampleSalary) < Math.abs(prev.employment_income - exampleSalary) ? curr : prev
          );
          const totalHouseholdIncome = closestPoint.employment_income + effectivePartnerIncome;

          return (
            <>
              <div className="narrative-chart-container">
                <div ref={takeHomeChartRef} className="narrative-chart"></div>
                <div className="chart-legend">
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>With student loan</span></div>
                </div>
              </div>

              <p>
                At £{d3.format(",.0f")(totalHouseholdIncome)} total household income, the household receives <strong>£{d3.format(",.0f")(closestPoint.household_net_income - closestPoint.student_loan_repayment)}</strong> net income with a student loan,
                compared to <strong>£{d3.format(",.0f")(closestPoint.household_net_income)}</strong> without
                {closestPoint.student_loan_repayment > 0 && <>—a difference of <strong>£{d3.format(",.0f")(closestPoint.student_loan_repayment)}</strong> per year</>}
                {closestPoint.universal_credit > 0 && <> (includes £{d3.format(",.0f")(closestPoint.universal_credit)} Universal Credit)</>}.
              </p>
            </>
          );
        })()}
      </section>

      {/* Section 3: Repayment timeline */}
      <section id="repaymentTimeline" ref={sectionRefs.repaymentTimeline} className="narrative-section">
        <h2>Repayment timeline</h2>
        <p>
          The following chart shows how the borrower's marginal tax rates change over the life of the loan based on years since graduation.
          {hasLoan && yearsSinceGraduation === 0 && ` With a graduation year of ${graduationYear}, you are starting repayment this year.`}
          {hasLoan && yearsSinceGraduation > 0 && ` With a graduation year of ${graduationYear}, you are currently ${yearsSinceGraduation} ${yearsSinceGraduation === 1 ? 'year' : 'years'} into repayment.`}
          {hasLoan && yearsSinceGraduation < 0 && ` With a graduation year of ${graduationYear}, repayments will begin in ${Math.abs(yearsSinceGraduation)} ${Math.abs(yearsSinceGraduation) === 1 ? 'year' : 'years'}.`}
          {hasLoan && ` Your ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loan will be written off after ${writeoffYears} years (in ${graduationYear + writeoffYears}).`}
        </p>

        <div className="narrative-chart-container">
          <div ref={ageChartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>Repaying (years 0-{writeoffYears - 1})</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>Written off (year {writeoffYears}+)</span></div>
          </div>
        </div>

        <p>
          At £{d3.format(",.0f")(exampleSalary)}, borrowers with a {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loan face a marginal rate of <strong>{(marginalWithLoan.totalRate * 100).toFixed(0)}%</strong> during repayment, dropping to <strong>{(marginalWithoutLoan.totalRate * 100).toFixed(0)}%</strong> once the loan is written off. Student loans are automatically written off after <strong>25 years</strong> for Plan 1, <strong>30 years</strong> for Plans 2 and 4, and <strong>40 years</strong> for Plan 5.
        </p>
      </section>

      {/* Section: Lifetime Loan Analysis */}
      {hasLoan && (
        <section id="lifetime" ref={sectionRefs.lifetime} className="narrative-section">
          <h2>Lifetime repayment analysis</h2>
          <p>
            The following chart projects the borrower's {lifetimeViewMode === 'cumulative' ? 'cumulative repayments and remaining balance' : 'annual repayments'} over the life of the loan.
            Total repayments depend on salary trajectory, the loan's interest rate, and the write-off period. {PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loans are written off after <strong>{getPlanWriteoffYears(params, selectedPlan)} years</strong>.
            This analysis starts from graduation year <strong>{graduationYear}</strong>{yearsSinceGraduation === 0 ? ' (this year)' : yearsSinceGraduation > 0 ? ` (${yearsSinceGraduation} ${yearsSinceGraduation === 1 ? 'year' : 'years'} ago)` : ` (${Math.abs(yearsSinceGraduation)} ${Math.abs(yearsSinceGraduation) === 1 ? 'year' : 'years'} from now)`}.
          </p>

          {apiError && <div className="api-error">Error: {apiError}</div>}

          {apiLoading ? (
            <div className="api-loading">Loading data from API...</div>
          ) : (
            <>
              <div className="narrative-chart-container">
                <div className="chart-toggle">
                  <button
                    className={`toggle-btn ${lifetimeViewMode === 'cumulative' ? 'active' : ''}`}
                    onClick={() => setLifetimeViewMode('cumulative')}
                  >
                    Cumulative
                  </button>
                  <button
                    className={`toggle-btn ${lifetimeViewMode === 'annual' ? 'active' : ''}`}
                    onClick={() => setLifetimeViewMode('annual')}
                  >
                    Annual
                  </button>
                </div>
                <div ref={lifetimeChartRef} className="narrative-chart"></div>
                <div className="chart-legend">
                  {lifetimeViewMode === 'cumulative' ? (
                    <>
                      <div className="legend-item"><div className="legend-color" style={{ background: COLORS.primary }}></div><span>Total repaid</span></div>
                      <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan, opacity: 0.7 }}></div><span>Remaining balance</span></div>
                    </>
                  ) : (
                    <div className="legend-item"><div className="legend-color" style={{ background: COLORS.primary }}></div><span>Annual repayment</span></div>
                  )}
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
            </>
          )}
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
