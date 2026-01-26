import { useState, useMemo, useEffect, useRef } from "react";
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

// Student loan plan options
const PLAN_OPTIONS = [
  { value: "none", label: "No student loan", threshold: null },
  { value: "plan1", label: "Plan 1", threshold: "slPlan1Threshold", description: "Started before Sept 2012 (Eng/Wales) or Scotland/NI" },
  { value: "plan2", label: "Plan 2", threshold: "slPlan2Threshold", description: "Started Sept 2012+ (England/Wales)" },
  { value: "plan4", label: "Plan 4", threshold: "slPlan4Threshold", description: "Scotland (from Sept 2021)" },
  { value: "plan5", label: "Plan 5", threshold: "slPlan5Threshold", description: "Started Aug 2023+ (England)" },
];

// Colours following PolicyEngine design system (from UK Autumn Budget dashboard)
const COLORS = {
  primary: "#319795",      // teal/500
  incomeTax: "#14B8A6",    // Teal 500 (good for households spectrum)
  ni: "#5EEAD4",           // Teal 300 (lighter teal)
  studentLoan: "#F59E0B",  // Amber 500 (lighter orange)
  postgradLoan: "#DC2626", // Red 600 (distinct from undergrad)
  withLoan: "#319795",     // teal/500
  withoutLoan: "#9CA3AF",  // gray/400
  text: "#101828",         // gray/900
  textSecondary: "#475569", // secondary/600
  border: "#E2E8F0",       // gray/200
};

// Slider configurations
const SLIDER_CONFIGS = [
  {
    id: "salary",
    label: "Annual salary",
    min: 0,
    max: 200000,
    step: 1000,
    format: (v) => `£${d3.format(",.0f")(v)}`,
    tooltip: "Your gross annual employment income.",
  },
  {
    id: "age",
    label: "Age",
    min: 22,
    max: 60,
    step: 1,
    format: (v) => v.toString(),
    tooltip: "Your current age (Plan 2 applies to those who started uni after 2012).",
  },
];

// Get threshold for a given plan
function getPlanThreshold(params, plan) {
  const thresholds = {
    plan1: params.slPlan1Threshold,
    plan2: params.slPlan2Threshold,
    plan4: params.slPlan4Threshold,
    plan5: params.slPlan5Threshold,
  };
  return thresholds[plan] || null;
}

// Calculate marginal rate at a given income using provided params
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

  if (
    grossIncome > params.paTaperThreshold &&
    grossIncome <= params.higherRateThreshold
  ) {
    itRate = params.higherRate + params.basicRate * params.paTaperRate;
  }

  if (grossIncome <= params.niPrimaryThreshold) {
    niRate = 0;
  } else if (grossIncome <= params.niUEL) {
    niRate = params.niMainRate;
  } else {
    niRate = params.niHigherRate;
  }

  // Undergraduate loan
  const planThreshold = getPlanThreshold(params, plan);
  if (planThreshold && grossIncome > planThreshold) {
    slRate = params.slRepaymentRate;
  }

  // Postgraduate loan (concurrent)
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

// Calculate actual deductions using provided params
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

  // Undergraduate loan
  let studentLoan = 0;
  const planThreshold = getPlanThreshold(params, plan);
  if (planThreshold && grossIncome > planThreshold) {
    studentLoan = (grossIncome - planThreshold) * params.slRepaymentRate;
  }

  // Postgraduate loan
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

// Generate marginal rate data using provided params
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

// Generate age-based comparison data (1-year steps)
function generateAgeData(selectedIncome, params, plan = "plan2", hasPostgrad = false) {
  const data = [];
  // Ages 22-60
  for (let age = 22; age <= 60; age++) {
    // Determine if this age would have this loan type
    const hasLoan = age < 40; // Simplified: assume under 40 could have any plan
    const rates = calculateMarginalRate(selectedIncome, params, hasLoan ? plan : "none", hasLoan ? hasPostgrad : false);
    data.push({
      age,
      hasLoan,
      totalRate: rates.totalRate * 100,
    });
  }
  return data;
}

// Generate take-home pay data using provided params
function generateTakeHomeData(params, plan = "plan2", hasPostgrad = false) {
  const data = [];
  const planThreshold = getPlanThreshold(params, plan) || 0;
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
  };
}

export default function StudentLoanCalculator() {
  // Form inputs (change immediately)
  const [inputs, setInputs] = useState({
    salary: 50000,
    age: 28,
    year: 2026,
    plan: "plan2",
    hasPostgrad: false,
  });
  // Calculated values (only change on Calculate click)
  const [calculatedInputs, setCalculatedInputs] = useState({
    salary: 50000,
    age: 28,
    year: 2026,
    plan: "plan2",
    hasPostgrad: false,
  });
  const [hasCalculated, setHasCalculated] = useState(false);
  const [allParams, setAllParams] = useState({});
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const chartRef = useRef(null);
  const ageChartRef = useRef(null);
  const takeHomeChartRef = useRef(null);
  const tooltipRef = useRef(null);

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
        // Use defaults
        setAllParams({ 2026: DEFAULT_PARAMS });
        setParamsLoaded(true);
      });
  }, []);

  // Handle Calculate button click
  const handleCalculate = () => {
    setCalculatedInputs({ ...inputs });
    setHasCalculated(true);
  };

  // Get params for calculated year (used for results)
  const params = useMemo(() => {
    if (!paramsLoaded) return DEFAULT_PARAMS;
    return allParams[calculatedInputs.year] || DEFAULT_PARAMS;
  }, [allParams, calculatedInputs.year, paramsLoaded]);

  // Get params for input year (used for sidebar display)
  const inputParams = useMemo(() => {
    if (!paramsLoaded) return DEFAULT_PARAMS;
    return allParams[inputs.year] || DEFAULT_PARAMS;
  }, [allParams, inputs.year, paramsLoaded]);

  const marginalRateData = useMemo(() => generateMarginalRateData(params, calculatedInputs.plan, calculatedInputs.hasPostgrad), [params, calculatedInputs.plan, calculatedInputs.hasPostgrad]);
  const ageData = useMemo(() => generateAgeData(calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad), [calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad]);
  const takeHomeData = useMemo(() => generateTakeHomeData(params, calculatedInputs.plan, calculatedInputs.hasPostgrad), [params, calculatedInputs.plan, calculatedInputs.hasPostgrad]);

  const hasLoan = calculatedInputs.plan !== "none";
  const planThreshold = getPlanThreshold(params, calculatedInputs.plan);

  const withLoan = useMemo(() => calculateDeductions(calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad), [calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad]);
  const withoutLoan = useMemo(() => calculateDeductions(calculatedInputs.salary, params, "none", false), [calculatedInputs.salary, params]);
  const marginalWithLoan = useMemo(() => calculateMarginalRate(calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad), [calculatedInputs.salary, params, calculatedInputs.plan, calculatedInputs.hasPostgrad]);
  const marginalWithoutLoan = useMemo(() => calculateMarginalRate(calculatedInputs.salary, params, "none", false), [calculatedInputs.salary, params]);

  const summaryStats = useMemo(() => {
    const marginalDiff = (marginalWithLoan.totalRate - marginalWithoutLoan.totalRate) * 100;

    return {
      annualRepayment: withLoan.studentLoan + withLoan.postgradLoan,
      marginalRate: marginalWithLoan.totalRate * 100,
      marginalDiff,
    };
  }, [withLoan, marginalWithLoan, marginalWithoutLoan]);

  const handleInputChange = (id, value) => {
    if (id === "plan") {
      setInputs((prev) => ({ ...prev, [id]: value }));
    } else if (id === "hasPostgrad") {
      setInputs((prev) => ({ ...prev, [id]: value }));
    } else {
      setInputs((prev) => ({ ...prev, [id]: parseFloat(value) }));
    }
  };

  // Chart 1: Marginal Rate with Stacked Breakdown
  useEffect(() => {
    if (!chartRef.current || !marginalRateData.length) return;

    const container = chartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 380 - margin.top - margin.bottom;

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

    // Stacked areas for breakdown (With Plan 2 loan)
    // Layer 1: Income Tax (bottom)
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

    // Layer 2: NI (on top of IT)
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

    // Layer 3: Student Loan (on top of IT + NI)
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

    // Layer 4: Postgraduate Loan (on top of IT + NI + SL)
    if (calculatedInputs.hasPostgrad) {
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

    // Line for "with loan" (solid)
    const lineWithLoan = d3.line()
      .x((d) => x(d.income))
      .y((d) => y(d.withLoan))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 2.5)
      .attr("d", lineWithLoan);

    // Line for "without loan" (dashed)
    const lineWithoutLoan = d3.line()
      .x((d) => x(d.income))
      .y((d) => y(d.withoutLoan))
      .curve(d3.curveStepAfter);

    g.append("path")
      .datum(marginalRateData)
      .attr("fill", "none")
      .attr("stroke", "#344054")
      .attr("stroke-width", 2.5)
      .attr("stroke-dasharray", "6,3")
      .attr("d", lineWithoutLoan);

    // Current salary marker
    if (calculatedInputs.salary > 0) {
      const currentRate = hasLoan ? marginalWithLoan.totalRate * 100 : marginalWithoutLoan.totalRate * 100;

      // Vertical line at current salary
      g.append("line")
        .attr("x1", x(calculatedInputs.salary)).attr("x2", x(calculatedInputs.salary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", "#344054").attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      g.append("circle")
        .attr("cx", x(calculatedInputs.salary)).attr("cy", y(currentRate)).attr("r", 8)
        .attr("fill", hasLoan ? COLORS.withLoan : COLORS.withoutLoan).attr("stroke", "#fff").attr("stroke-width", 2);
      g.append("text")
        .attr("x", x(calculatedInputs.salary) + 8).attr("y", 15).attr("text-anchor", "start")
        .attr("font-size", "12px").attr("font-weight", "600").attr("fill", "#344054")
        .text(`${currentRate.toFixed(0)}%`);
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
        const postgradRow = calculatedInputs.hasPostgrad ? `<div class="tooltip-row"><span style="color:${COLORS.postgradLoan}">● Postgrad loan</span><span style="font-weight:600">${d.postgrad.toFixed(0)}%</span></div>` : '';
        tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
          .html(`<div class="tooltip-title">£${d3.format(",.0f")(d.income)}</div>
            <div class="tooltip-section">
              <div class="tooltip-row"><span style="color:${COLORS.incomeTax}">● Income tax</span><span style="font-weight:600">${d.incomeTax.toFixed(0)}%</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.ni}">● National Insurance</span><span style="font-weight:600">${d.ni.toFixed(0)}%</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.studentLoan}">● Student loan</span><span style="font-weight:600">${d.studentLoan.toFixed(0)}%</span></div>
              ${postgradRow}
            </div>
            <div class="tooltip-row tooltip-total"><span>Total (with loan)</span><span style="color:${COLORS.withLoan};font-weight:700">${d.withLoan.toFixed(0)}%</span></div>
            <div class="tooltip-row"><span>Without loan</span><span style="color:${COLORS.withoutLoan};font-weight:600">${d.withoutLoan.toFixed(0)}%</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [marginalRateData, calculatedInputs.salary, hasLoan, marginalWithLoan, marginalWithoutLoan, hasCalculated, calculatedInputs.hasPostgrad]);

  // Chart 2: Age-based comparison (1-year steps)
  useEffect(() => {
    if (!ageChartRef.current) return;

    const container = ageChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 300 - margin.top - margin.bottom;

    const svg = d3.select(container).append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(ageData.map((d) => d.age)).range([0, width]).padding(0.1);
    const y = d3.scaleLinear().domain([0, 80]).range([height, 0]);

    g.append("g").attr("class", "grid").call(d3.axisLeft(y).tickSize(-width).tickFormat("").ticks(8));

    // Add reference line at age 32 (Plan 2 cutoff)
    const cutoffX = x(32);
    if (cutoffX !== undefined) {
      g.append("line")
        .attr("x1", cutoffX).attr("x2", cutoffX)
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", "#e2e8f0").attr("stroke-width", 2).attr("stroke-dasharray", "4,4");
      g.append("text")
        .attr("x", cutoffX + 5).attr("y", 15)
        .attr("font-size", "10px").attr("fill", "#94a3b8")
        .text("Plan 2 cutoff");
    }

    // Tooltip
    const tooltip = d3.select(tooltipRef.current);

    // Bars with hover
    ageData.forEach((d) => {
      g.append("rect")
        .attr("x", x(d.age))
        .attr("y", y(d.totalRate))
        .attr("width", x.bandwidth())
        .attr("height", y(0) - y(d.totalRate))
        .attr("fill", d.hasLoan ? COLORS.withLoan : COLORS.withoutLoan)
        .attr("rx", 1)
        .style("cursor", "pointer")
        .on("mouseover", function (event) {
          d3.select(this).attr("opacity", 0.8);
          tooltip.style("opacity", 1).style("left", event.clientX + 15 + "px").style("top", event.clientY - 10 + "px")
            .html(`<div class="tooltip-title">Age ${d.age}</div>
              <div class="tooltip-row"><span>Marginal rate</span><span style="font-weight:600">${d.totalRate.toFixed(0)}%</span></div>
              <div class="tooltip-row"><span>Student loan</span><span style="font-weight:600">${d.hasLoan ? "Yes" : "No"}</span></div>`);
        })
        .on("mouseout", function () {
          d3.select(this).attr("opacity", 1);
          tooltip.style("opacity", 0);
        });
    });

    // X-axis with selective labels
    const xAxis = d3.axisBottom(x)
      .tickValues(ageData.filter((d) => d.age % 5 === 0 || d.age === 22 || d.age === 32).map((d) => d.age))
      .tickFormat((d) => d);
    g.append("g").attr("class", "axis x-axis").attr("transform", `translate(0,${height})`).call(xAxis);
    g.append("text").attr("x", width / 2).attr("y", height + 40).attr("text-anchor", "middle")
      .attr("font-size", "12px").attr("fill", "#64748B").text("Age");
    g.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).tickFormat((d) => `${d}%`).ticks(8));
  }, [ageData, hasCalculated]);

  // Chart 3: Take-Home Pay
  useEffect(() => {
    if (!takeHomeChartRef.current) return;

    const container = takeHomeChartRef.current;
    d3.select(container).selectAll("*").remove();

    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = 300 - margin.top - margin.bottom;

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
    g.append("path").datum(takeHomeData.filter((d) => d.income >= params.slPlan2Threshold))
      .attr("fill", COLORS.studentLoan).attr("fill-opacity", 0.1).attr("d", gapArea);

    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withoutLoan).attr("stroke-width", 2.5).attr("d", lineWithoutLoan);
    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withLoan).attr("stroke-width", 2.5).attr("d", lineWithLoan);

    // Current salary marker
    if (calculatedInputs.salary > 0 && calculatedInputs.salary <= 150000) {
      const netWithLoan = withLoan.netIncome;
      const netWithoutLoan = withoutLoan.netIncome;

      // Vertical line
      g.append("line")
        .attr("x1", x(calculatedInputs.salary)).attr("x2", x(calculatedInputs.salary))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", "#344054").attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");

      // Markers on both lines
      g.append("circle")
        .attr("cx", x(calculatedInputs.salary)).attr("cy", y(netWithoutLoan)).attr("r", 6)
        .attr("fill", COLORS.withoutLoan).attr("stroke", "#fff").attr("stroke-width", 2);
      g.append("circle")
        .attr("cx", x(calculatedInputs.salary)).attr("cy", y(netWithLoan)).attr("r", 6)
        .attr("fill", COLORS.withLoan).attr("stroke", "#fff").attr("stroke-width", 2);

      // Gap annotation - positioned at top right of vertical line
      const gap = netWithoutLoan - netWithLoan;
      if (gap > 0) {
        g.append("text")
          .attr("x", x(calculatedInputs.salary) + 8).attr("y", 15)
          .attr("text-anchor", "start")
          .attr("font-size", "11px").attr("font-weight", "600").attr("fill", COLORS.studentLoan)
          .text(`-£${d3.format(",.0f")(gap)}`);
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
              <div class="tooltip-row"><span style="color:${COLORS.withoutLoan}">● No student loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.withoutLoan)}</span></div>
              <div class="tooltip-row"><span style="color:${COLORS.withLoan}">● With student loan</span><span style="font-weight:600">£${d3.format(",.0f")(d.withLoan)}</span></div>
            </div>
            <div class="tooltip-row tooltip-total"><span>Difference</span><span style="color:${COLORS.studentLoan};font-weight:700">-£${d3.format(",.0f")(gap)}</span></div>`);
      })
      .on("mouseout", () => tooltip.style("opacity", 0));
  }, [takeHomeData, calculatedInputs.salary, withLoan, withoutLoan, hasCalculated]);

  return (
    <div className="student-loan-calculator">
      <div className="lifecycle-header">
        <div className="lifecycle-header-content">
          <h2>Student loan as effective National Insurance</h2>
          <p className="lifecycle-subtitle">
            Compare marginal deduction rates for workers with and without student loans
          </p>
        </div>
      </div>

      {/* About section - moved to top */}
      <div className="about-section">
        <div className="policy-box">
          <p>
            This dashboard shows true marginal deduction rates when combining income tax (20% basic, 40% higher, 45% additional), National Insurance (8% main rate, 2% above £50,270), and Plan 2 student loan repayments (9% above £29,385). Workers under 32 with Plan 2 loans face marginal rates up to 51% (or 71% in the PA taper zone), 9 percentage points higher than older workers on the same salary. This effectively creates a generational tax disparity where younger and older workers doing the same job take home different amounts.
          </p>
          <p>
            In the Autumn Budget 2025, the Government announced it will freeze the Plan 2 student loan repayment threshold at £29,385 for three years from April 2027, instead of allowing RPI uprating. This means graduates start repaying at a lower real income level, increasing repayments. Plan 2 student loan repayments effectively function as a generational payroll tax, with the 9% repayment rate creating higher effective marginal rates for younger workers compared to older colleagues on the same salary.
          </p>
        </div>
      </div>

      <div className="lifecycle-layout">
        {/* Controls sidebar */}
        <div className="lifecycle-controls">
          <h3>Your details</h3>

          {SLIDER_CONFIGS.map((config) => (
            <div className="control-group" key={config.id}>
              <label title={config.tooltip}>{config.label}</label>
              <div className="slider-container">
                <input type="range" value={inputs[config.id]} min={config.min} max={config.max} step={config.step}
                  onChange={(e) => handleInputChange(config.id, e.target.value)} />
                <span className="slider-value">{config.format(inputs[config.id])}</span>
              </div>
            </div>
          ))}

          <div className="control-group">
            <label>Tax year</label>
            <select
              value={inputs.year}
              onChange={(e) => handleInputChange('year', e.target.value)}
              className="year-select"
            >
              <option value={2026}>2026/27</option>
              <option value={2027}>2027/28</option>
              <option value={2028}>2028/29</option>
              <option value={2029}>2029/30</option>
              <option value={2030}>2030/31</option>
            </select>
          </div>

          <div className="control-group">
            <label>Student loan plan</label>
            <select
              value={inputs.plan}
              onChange={(e) => handleInputChange('plan', e.target.value)}
              className="year-select"
            >
              {PLAN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {inputs.plan !== "none" && (
              <div className="plan-description">
                {PLAN_OPTIONS.find(p => p.value === inputs.plan)?.description}
              </div>
            )}
          </div>

          <div
            className={`postgrad-toggle ${inputs.hasPostgrad ? "active" : ""}`}
            onClick={() => handleInputChange('hasPostgrad', !inputs.hasPostgrad)}
          >
            <div className="postgrad-toggle-header">
              <div className={`toggle-switch ${inputs.hasPostgrad ? "on" : ""}`}>
                <div className="toggle-knob"></div>
              </div>
              <span className="postgrad-toggle-label">Postgraduate loan</span>
            </div>
            <div className="postgrad-toggle-detail">
              6% above £{d3.format(",.0f")(inputParams.slPostgradThreshold || 22722)}
            </div>
          </div>

          <button className="calculate-button" onClick={handleCalculate}>Calculate</button>
        </div>

        {/* Main content */}
        <div className="lifecycle-main">
          {!hasCalculated ? (
            <div className="placeholder-box">
              <div className="placeholder-icon">📊</div>
              <h3>Enter your details to see results</h3>
              <p>Adjust your salary, age, and tax year in the sidebar, then click Calculate to see your marginal deduction rates and how they compare to other workers.</p>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="lifecycle-summary">
                <div className="summary-item highlighted">
                  <div className="summary-label">
                    Your marginal rate
                    <span className="info-icon" data-tooltip="The percentage of each additional pound you earn that goes to tax, NI, and student loan repayments combined.">ⓘ</span>
                  </div>
                  <div className="summary-value">
                    {(hasLoan ? marginalWithLoan.totalRate * 100 : marginalWithoutLoan.totalRate * 100).toFixed(0)}%
                  </div>
                </div>
                <div className="summary-item">
                  <div className="summary-label">
                    {hasLoan ? "Annual student loan" : "No student loan"}
                    <span className="info-icon" data-tooltip={hasLoan ? `9% of income above £${d3.format(",.0f")(planThreshold)} goes to student loan repayments each year.${calculatedInputs.hasPostgrad ? ` Plus 6% postgrad above £${d3.format(",.0f")(params.slPostgradThreshold)}.` : ""}` : "You don't have a student loan."}>ⓘ</span>
                  </div>
                  <div className={`summary-value ${hasLoan ? "negative" : ""}`}>
                    {hasLoan ? `-£${d3.format(",.0f")(withLoan.studentLoan)}` : "£0"}
                  </div>
                </div>
                <div className="summary-item">
                  <div className="summary-label">
                    Rate vs older worker
                    <span className="info-icon" data-tooltip={hasLoan ? "Workers with student loans face higher marginal rates than those without due to the additional repayment percentage." : "Without a student loan, your marginal rate matches workers without loans."}>ⓘ</span>
                  </div>
                  <div className={`summary-value ${hasLoan ? "negative" : ""}`}>
                    {hasLoan ? `+${summaryStats.marginalDiff.toFixed(0)}pp` : "Same"}
                  </div>
                </div>
              </div>

              {/* Your deductions summary box */}
              <div className="deductions-box">
                <div className="deductions-header">
                  <div className="status-info">
                    <span className="status-badge with-loan">
                      {hasLoan ? PLAN_OPTIONS.find(p => p.value === calculatedInputs.plan)?.label : "No student loan"}
                      {calculatedInputs.hasPostgrad && " + Postgrad"}
                    </span>
                    <span className="status-note">
                      {hasLoan && PLAN_OPTIONS.find(p => p.value === calculatedInputs.plan)?.description}
                    </span>
                  </div>
                </div>
                <div className={`deductions-grid ${calculatedInputs.hasPostgrad ? "with-postgrad" : ""}`}>
                  <div className="deduction-item">
                    <span className="deduction-label">Gross salary</span>
                    <span className="deduction-value">£{d3.format(",.0f")(calculatedInputs.salary)}</span>
                  </div>
                  <div className="deduction-item">
                    <span className="deduction-label">Income tax</span>
                    <span className="deduction-value negative">-£{d3.format(",.0f")(withLoan.incomeTax)}</span>
                  </div>
                  <div className="deduction-item">
                    <span className="deduction-label">National Insurance</span>
                    <span className="deduction-value negative">-£{d3.format(",.0f")(withLoan.ni)}</span>
                  </div>
                  {hasLoan && (
                    <div className="deduction-item">
                      <span className="deduction-label">{PLAN_OPTIONS.find(p => p.value === calculatedInputs.plan)?.label} loan</span>
                      <span className="deduction-value negative">-£{d3.format(",.0f")(withLoan.studentLoan)}</span>
                    </div>
                  )}
                  {calculatedInputs.hasPostgrad && (
                    <div className="deduction-item">
                      <span className="deduction-label">Postgrad loan</span>
                      <span className="deduction-value negative">-£{d3.format(",.0f")(withLoan.postgradLoan)}</span>
                    </div>
                  )}
                  <div className="deduction-item total">
                    <span className="deduction-label">Take-home pay</span>
                    <span className="deduction-value positive">£{d3.format(",.0f")(withLoan.netIncome)}</span>
                  </div>
                </div>
              </div>

              {/* Chart 1: Marginal Rate with Breakdown */}
              <div className="chart-container">
                <h3 className="chart-title">Marginal deduction rate by income</h3>
                <p className="chart-subtitle">
                  Stacked breakdown shows how income tax, NI, and student loan combine. The solid line shows the total rate with a student loan, the dashed line without.
                </p>
                <div ref={chartRef} className="chart"></div>
                <div className="legend">
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.incomeTax }}></div><span>Income tax</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.ni }}></div><span>National Insurance</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan }}></div><span>Student loan</span></div>
                  {calculatedInputs.hasPostgrad && (
                    <div className="legend-item"><div className="legend-color" style={{ background: COLORS.postgradLoan }}></div><span>Postgrad loan</span></div>
                  )}
                  <div className="legend-item"><div className="legend-color" style={{ background: "#344054", height: "2px", borderRadius: 0 }}></div><span>With loan</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: "#344054", height: "2px", borderRadius: 0, borderTop: "2px dashed #344054", backgroundColor: "transparent" }}></div><span>Without loan</span></div>
                </div>
              </div>

              {/* Chart 2: Age-based Comparison */}
              <div className="chart-container">
                <h3 className="chart-title">Marginal rate by age at £{d3.format(",.0f")(calculatedInputs.salary)}</h3>
                <p className="chart-subtitle">
                  Workers with student loans face higher marginal rates than those without at the same salary level.
                </p>
                <div ref={ageChartRef} className="chart chart-short"></div>
                <div className="legend">
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>Has student loan</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan (32+)</span></div>
                </div>
              </div>

              {/* Chart 3: Take-Home Pay */}
              <div className="chart-container">
                <h3 className="chart-title">Take-home pay comparison</h3>
                <p className="chart-subtitle">
                  The growing gap shows how much less someone with a student loan takes home vs someone without at the same salary.
                </p>
                <div ref={takeHomeChartRef} className="chart chart-short"></div>
                <div className="legend">
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan</span></div>
                  <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>With student loan</span></div>
                </div>
              </div>
            </>
          )}

        </div>
      </div>

      <div ref={tooltipRef} className="lifecycle-tooltip"></div>
    </div>
  );
}
