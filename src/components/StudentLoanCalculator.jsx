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

export default function StudentLoanCalculator() {
  const [allParams, setAllParams] = useState({});
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const [selectedYear, setSelectedYear] = useState(2026);
  const [selectedPlan, setSelectedPlan] = useState("plan2");
  const [showPostgrad, setShowPostgrad] = useState(false);
  const [exampleSalary, setExampleSalary] = useState(50000);
  const chartRef = useRef(null);
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
        setAllParams({ 2026: DEFAULT_PARAMS });
        setParamsLoaded(true);
      });
  }, []);

  const params = useMemo(() => {
    if (!paramsLoaded) return DEFAULT_PARAMS;
    return allParams[selectedYear] || DEFAULT_PARAMS;
  }, [allParams, selectedYear, paramsLoaded]);

  const marginalRateData = useMemo(() => generateMarginalRateData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);
  const takeHomeData = useMemo(() => generateTakeHomeData(params, selectedPlan, showPostgrad), [params, selectedPlan, showPostgrad]);

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
      .attr("stroke-width", 2.5)
      .attr("d", lineWithLoan);

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

    // Key income markers
    const keyIncomes = [
      { income: planThreshold, label: "Repayment threshold", color: COLORS.studentLoan },
      { income: exampleSalary, label: `£${d3.format(",.0f")(exampleSalary)}`, color: COLORS.primary },
    ];

    keyIncomes.forEach(({ income, label, color }) => {
      const rate = calculateMarginalRate(income, params, true, showPostgrad).totalRate * 100;
      g.append("line")
        .attr("x1", x(income)).attr("x2", x(income))
        .attr("y1", 0).attr("y2", height)
        .attr("stroke", color).attr("stroke-width", 1.5).attr("stroke-dasharray", "4,2");
      g.append("circle")
        .attr("cx", x(income)).attr("cy", y(rate)).attr("r", 6)
        .attr("fill", color).attr("stroke", "#fff").attr("stroke-width", 2);
    });

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
  }, [marginalRateData, params, paramsLoaded, showPostgrad, planThreshold, exampleSalary]);

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

    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withoutLoan).attr("stroke-width", 2.5).attr("d", lineWithoutLoan);
    g.append("path").datum(takeHomeData).attr("fill", "none").attr("stroke", COLORS.withLoan).attr("stroke-width", 2.5).attr("d", lineWithLoan);

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
          .attr("x", x(exampleSalary) + 8).attr("y", (y(netWithLoan) + y(netWithoutLoan)) / 2 + 4)
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

  const annualRepayment = withLoan.studentLoan + withLoan.postgradLoan;
  const marginalDiff = (marginalWithLoan.totalRate - marginalWithoutLoan.totalRate) * 100;

  return (
    <div className="narrative-container">
      {/* Hero Section */}
      <header className="narrative-hero">
        <h1>Student loan repayments as effective National Insurance</h1>
        <p className="narrative-lead">
          Student loan repayments add 9% to marginal deduction rates above the repayment threshold.
          This analysis examines how student loan repayments interact with income tax and National Insurance.
        </p>
      </header>

      {/* Controls Panel */}
      <section className="controls-panel">
        <div className="controls-grid">
          <div className="control-item">
            <label>Annual salary</label>
            <div className="salary-input-wrapper">
              <span className="currency-symbol">£</span>
              <input
                type="number"
                value={exampleSalary}
                onChange={(e) => setExampleSalary(Math.max(0, parseInt(e.target.value) || 0))}
                min="0"
                max="500000"
                step="1000"
              />
            </div>
          </div>
          <div className="control-item">
            <label>Student loan plan</label>
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
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={showPostgrad}
                onChange={(e) => setShowPostgrad(e.target.checked)}
              />
              Postgraduate loan
            </label>
            <span className="control-hint">6% above £{d3.format(",.0f")(params.slPostgradThreshold)}</span>
          </div>
        </div>
      </section>

      {/* Section 1: Overview */}
      <section className="narrative-section">
        <h2>Overview</h2>
        <p>
          Marginal deduction rates for UK workers typically comprise income tax (20%/40%/45%) and National Insurance
          (8%/2%). For workers with student loans, an additional 9% repayment rate applies to earnings above the
          plan threshold{hasLoan && ` (£${d3.format(",.0f")(planThreshold)} for ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label})`}.
        </p>
        <p>
          This creates combined marginal rates of <strong>37%</strong> for basic rate taxpayers with loans
          (vs 28% without), and <strong>51%</strong> for higher rate taxpayers between £50,270 and £100,000
          (vs 42% without). In the personal allowance taper zone (£100,000–£125,140), the effective marginal
          rate reaches <strong>{showPostgrad ? "77" : "71"}%</strong>.
        </p>
      </section>

      {/* Chart 1: Marginal Rates */}
      <section className="narrative-section">
        <h2>Marginal deduction rates by income</h2>
        <p>
          The chart shows the composition of marginal deduction rates across the income distribution:
          income tax (teal), National Insurance (light teal), and student loan repayments (amber).
          The solid line indicates the total rate with a student loan; the dashed line shows the rate without.
        </p>

        <div className="narrative-chart-container">
          <div ref={chartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.incomeTax }}></div><span>Income tax</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.ni }}></div><span>National Insurance</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.studentLoan }}></div><span>Student loan</span></div>
            {showPostgrad && <div className="legend-item"><div className="legend-color" style={{ background: COLORS.postgradLoan }}></div><span>Postgrad loan</span></div>}
          </div>
        </div>

        <p>
          {hasLoan ? `The student loan repayment band (amber) begins at £${d3.format(",.0f")(planThreshold)}—the ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} threshold. Above this level, each additional pound of earnings incurs the 9% repayment rate alongside income tax and NI.` : "Select a student loan plan above to see the impact of repayments on marginal rates."}
        </p>
      </section>

      {/* Callout: Key Numbers */}
      <section className="narrative-callout">
        <div className="callout-grid">
          <div className="callout-item">
            <div className="callout-number">{(marginalWithLoan.totalRate * 100).toFixed(0)}%</div>
            <div className="callout-label">Marginal rate at £{d3.format(",.0f")(exampleSalary)}{hasLoan && " (with loan)"}</div>
          </div>
          <div className="callout-item">
            <div className="callout-number">{(marginalWithoutLoan.totalRate * 100).toFixed(0)}%</div>
            <div className="callout-label">Marginal rate at £{d3.format(",.0f")(exampleSalary)} (no loan)</div>
          </div>
          <div className="callout-item highlight">
            <div className="callout-number">{hasLoan ? `+${marginalDiff.toFixed(0)}pp` : "—"}</div>
            <div className="callout-label">Difference</div>
          </div>
        </div>
      </section>

      {/* Section 2: Take-Home Impact */}
      <section className="narrative-section">
        <h2>Impact on take-home pay</h2>
        <p>
          At £{d3.format(",.0f")(exampleSalary)} gross salary, {hasLoan ? `a worker with a ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} loan receives` : "a worker receives"} <strong>£{d3.format(",.0f")(withLoan.netIncome)}</strong> net
          {hasLoan && <>, compared to <strong>£{d3.format(",.0f")(withoutLoan.netIncome)}</strong> for a worker without a loan—a difference of <strong>£{d3.format(",.0f")(annualRepayment)}</strong> per year</>}.
        </p>

        <div className="narrative-chart-container">
          <div ref={takeHomeChartRef} className="narrative-chart"></div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withoutLoan }}></div><span>No student loan</span></div>
            <div className="legend-item"><div className="legend-color" style={{ background: COLORS.withLoan }}></div><span>With student loan</span></div>
          </div>
        </div>

        <p>
          The shaded area shows the cumulative difference in take-home pay. This gap increases with income,
          as higher earners make larger absolute repayments.
        </p>
      </section>

      {/* Section 3: Policy Context */}
      <section className="narrative-section">
        <h2>Policy context</h2>
        <p>
          The Autumn Budget 2025 announced a freeze on the Plan 2 repayment threshold at £{d3.format(",.0f")(params.slPlan2Threshold)} for
          three years from April 2027, rather than uprating by RPI. This results in graduates beginning
          repayments at a lower real income level over time.
        </p>
        <p>
          Student loan repayments differ from income tax and National Insurance in that they do not fund
          public services or contribute to state pension entitlement. However, in terms of their effect on
          take-home pay, they function similarly to an additional payroll deduction.
        </p>
        <p>
          Two workers at the same salary performing the same role will have different net incomes if one has
          a Plan 2 loan. This represents a structural difference in effective tax burden by cohort.
        </p>
      </section>

      {/* Methodology */}
      <footer className="narrative-footer">
        <h3>Methodology</h3>
        <p>
          Analysis based on {selectedYear}/{selectedYear + 1 - 2000} tax year parameters.
          Calculations assume employment income only.
          {hasLoan && ` ${PLAN_OPTIONS.find(p => p.value === selectedPlan)?.label} repayments: 9% of earnings above £${d3.format(",.0f")(planThreshold)}.`}
          {showPostgrad && ` Postgraduate loan: 6% above £${d3.format(",.0f")(params.slPostgradThreshold)}.`}
        </p>
        <p className="source-link">
          Analysis by <a href="https://policyengine.org" target="_blank" rel="noopener noreferrer">PolicyEngine</a>
        </p>
      </footer>

      <div ref={tooltipRef} className="lifecycle-tooltip"></div>
    </div>
  );
}
