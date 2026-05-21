#!/usr/bin/env node
/**
 * BigCommerce -> Shopify product CSV exporter.
 *
 * Fetches BigCommerce products, categories, and brands, then writes a Shopify
 * product import CSV to out/products-export.csv. Category data is used only to
 * create useful product tags and a small product map for follow-up work.
 */
const axios = require("axios");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parse } = require("json2csv");
const readline = require("node:readline");
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const SKIP_CATEGORY = process.env.SKIP_CATEGORY || "Shop";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const BATCH_DELAY = 2000;

// env / CLI
let storeHash;
let accessToken;
let defaultVendor;
let apiUrl;

// ───────────────────────────────────────────────────────────────────────────────
// FS helpers
// ───────────────────────────────────────────────────────────────────────────────
async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true }).catch(() => {});
}
const outPath = (name) => path.join(OUT_DIR, name);

// ───────────────────────────────────────────────────────────────────────────────
// CLI prompt helper
// ───────────────────────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// ───────────────────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getRequest(url, config, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const res = await axios.get(url, config);
      const left = Number.parseInt(res.headers["x-rate-limit-requests-left"], 10);
      const reset = Number.parseInt(res.headers["x-rate-limit-time-reset-ms"], 10);
      if (!Number.isNaN(left) && left < 10 && reset) await delay(reset);
      return res;
    } catch (err) {
      if (err.response?.status === 429) {
        const retryMs = Number.parseInt(err.response.headers["x-rate-limit-time-reset-ms"], 10) || 5000;
        await delay(retryMs);
        attempt++;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Failed GET ${url} after ${maxRetries} retries`);
}

// ───────────────────────────────────────────────────────────────────────────────
// Fetch BC data
// ───────────────────────────────────────────────────────────────────────────────
async function fetchAll(endpoint, { limit = 250, batchSize = 10, params = {} } = {}) {
  let items = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      promises.push(
        getRequest(`${apiUrl}/${endpoint}`, {
          headers: {
            "X-Auth-Token": accessToken,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          params: { page: page + i, limit, ...params },
        })
      );
    }
    const responses = await Promise.all(promises);
    for (const r of responses) {
      items = items.concat(r.data.data || []);
      const totalPages = r.data.meta?.pagination?.total_pages || 1;
      const current = r.data.meta?.pagination?.current_page || 1;
      if (current >= totalPages) hasMore = false;
    }
    if (hasMore) await delay(BATCH_DELAY);
    page += batchSize;
  }
  return items;
}

async function fetchAllProducts() {
  return fetchAll("products", {
    limit: 250,
    batchSize: 25,
    params: { include: "images,bulk_pricing_rules,reviews,modifiers,options,custom_fields,variants" },
  });
}
async function fetchAllCategories() { return fetchAll("categories", { limit: 250, batchSize: 6 }); }
async function fetchAllBrands() { return fetchAll("brands", { limit: 250, batchSize: 10 }); }

// ───────────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────────
function cleanDescription(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<img[^>]*\/?>/gi, "")
    .replace(/<p[^>]*>.*?<img[^>]*\/?.*?<\/p>/gi, "")
    .replace(/<p[^>]*>&nbsp;<\/p>/gi, "")
    .replace(/<p[^>]*><\/p>/gi, "")
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function cleanString(str) { return (str || "").replace(/[\n\r\t]+/g, " ").trim(); }
function handleize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

// index maps
let categoryMap = {};
let brandMap = {};
const ancestryCache = {};

function getCategoryAncestry(categoryId) {
  if (ancestryCache[categoryId]) return ancestryCache[categoryId];
  const c = categoryMap[categoryId];
  if (!c) return (ancestryCache[categoryId] = []);
  if (!c.parent_id || !categoryMap[c.parent_id]) return (ancestryCache[categoryId] = [c.name]);
  const anc = getCategoryAncestry(c.parent_id);
  return (ancestryCache[categoryId] = [...anc, c.name]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Tag Generation Logic (from add-product-tags.js)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Convert string to proper title case, excluding articles, prepositions, and conjunctions
 */
function toTitleCase(str) {
  if (!str) return "";
  
  // Words that should not be capitalized (unless they're the first or last word)
  const minorWords = [
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'nor', 'of', 
    'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with', 'from', 'into', 'onto', 
    'per', 'than', 'upon', 'via', 'are', 'is', 'was', 'were', 'be', 'been', 'being'
  ];
  
  return str.toLowerCase()
    .split(' ')
    .map((word, index, array) => {
      // Always capitalize first and last word
      if (index === 0 || index === array.length - 1) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      
      // Don't capitalize minor words
      if (minorWords.includes(word.toLowerCase())) {
        return word.toLowerCase();
      }
      
      // Capitalize everything else
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Standardize category display name (clean, apply title case, and remove & prefix).
 */
function formatCategoryName(name) {
  let formatted = toTitleCase(cleanString(name));
  // Replace any ", & " with ", " to remove ampersand prefixes in lists
  formatted = formatted.replace(/, & /g, ', ');
  // Also remove "& " from the beginning
  formatted = formatted.replace(/^& /, '');
  return formatted;
}

/**
 * Generate tags for a product based on its BigCommerce categories
 */
function generateTagsForProduct(bcProduct) {
  // Build tags from category ancestry.
  const ancestryNames = (bcProduct.categories || []).flatMap((catId) =>
    getCategoryAncestry(catId)
  );
  
  // Apply title case formatting and filter out unwanted tags
  const uniqueTags = Array.from(new Set(ancestryNames.map(name => formatCategoryName(name))))
    .filter((tag) => {
      // Filter out empty tags, tags with numbers, the "Shop" wrapper category, and "and More"
      return tag.length > 0 && 
             !/\d/.test(tag) && 
             tag.toLowerCase() !== 'shop' &&
             tag.toLowerCase() !== 'and more';
    });
  
  return uniqueTags;
}

function convertWeightToPounds(weight, unit) {
  if (!weight) return "";
  const w = Number.parseFloat(weight);
  const u = (unit || "").toLowerCase();
  if (u === "kg") return (w * 2.20462).toFixed(2);
  if (u === "g") return (w * 0.00220462).toFixed(2);
  if (u === "oz") return (w * 0.0625).toFixed(2);
  if (u === "lb") return w.toFixed(2);
  return w;
}

function convertWeightToGrams(weight, unit) {
  if (!weight) return "";
  const w = Number.parseFloat(weight);
  const u = (unit || "").toLowerCase();
  if (u === "kg") return (w * 1000).toFixed(2);
  if (u === "g") return w.toFixed(2);
  if (u === "oz") return (w * 28.3495).toFixed(2);
  if (u === "lb") return (w * 453.592).toFixed(2);
  return w;
}

function buildImageRows(handle, images = [], primary = null) {
  const rows = [];
  const seen = new Set();
  const norm = (u) => String(u || "").split("?")[0].split("#")[0].trim().toLowerCase();

  if (primary) {
    const u = primary.url_zoom || primary.url_standard || "";
    const key = norm(u);
    if (key && !seen.has(key)) {
      seen.add(key);
      rows.push({ Handle: handle, "Image Src": u, "Image Position": 1, "Image Alt Text": primary.description || "" });
    }
  }

  const sorted = images.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const primaryId = primary?.id;

  for (const img of sorted) {
    if (primaryId != null && img?.id === primaryId) continue;
    const u = img?.url_zoom || img?.url_standard || "";
    const key = norm(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      Handle: handle,
      "Image Src": u,
      "Image Position": rows.length + 1,
      "Image Alt Text": img?.description || "",
    });
  }
  return rows;
}

// ───────────────────────────────────────────────────────────────────────────────
// Exporters
// ───────────────────────────────────────────────────────────────────────────────
function buildCSVRows(bcProducts) {
  const rows = [];
  const productsMap = []; // drives assignment later

  for (const p of bcProducts) {
    if (p.is_visible === false) continue;

    const title = cleanString(p.name);
    const handle = handleize(title);
    const bodyHtml = cleanDescription(p.description || "");
    const brand = brandMap[p.brand_id]?.name || defaultVendor;

    // Generate tags from category hierarchy
    const productTags = generateTagsForProduct(p);
    const tagsString = productTags.join(', ');

    // Map BC image id -> url and a helper to normalize/compare URLs
    const imageIdToUrl = {};
    const normalize = (u) => String(u || "").split("?")[0].split("#")[0].trim().toLowerCase();
    const productImageUrls = new Set();
    for (const img of (p.images || [])) {
      const url = img?.url_zoom || img?.url_standard || "";
      if (img?.id != null) imageIdToUrl[img.id] = url;
      if (url) productImageUrls.add(normalize(url));
    }

    const variants = (Array.isArray(p.variants) && p.variants.length > 0)
      ? p.variants
      : [{
          sku: p.sku || "",
          price: p.price,
          inventory_level: p.inventory_level || 0,
          upc: p.upc || "",
          option_values: [],
        }];

    let options = Array.isArray(p.options) ? p.options.slice(0, 3) : [];
    let status = p.options && p.options.length > 3 ? "draft" : "active";

    // We'll collect any variant-only image URLs that aren't already in p.images
    const extraVariantImageUrls = new Set();

  let first = true;
  for (const v of variants) {
      // Resolve the variant's image URL: prefer explicit v.image_url, else via v.image_id
      const vImageUrlRaw = v?.image_url || (v?.image_id != null ? imageIdToUrl[v.image_id] : "");
      const vImageUrl = vImageUrlRaw || "";
      if (vImageUrl && !productImageUrls.has(normalize(vImageUrl))) {
        extraVariantImageUrls.add(vImageUrl);
      }
      // Determine weight and unit for this row: prefer variant-level; fallback to product-level
      const weightVal = (v && v.weight != null && v.weight !== "") ? v.weight : p.weight;
      const weightUnit = (v && v.weight_unit) ? v.weight_unit : (p.weight_unit || "lb");

      const row = {
        Handle: handle,
        Title: first ? title : "",
        "Body (HTML)": first ? bodyHtml : "",
        Vendor: first ? brand : "",
        "Product Category": "",
        Type: "",
        Tags: first ? tagsString : "", // ← Add generated tags to first row only
        Published: first ? "TRUE" : "",
        "Option1 Name": "",
        "Option1 Value": "",
        "Option2 Name": "",
        "Option2 Value": "",
        "Option3 Name": "",
        "Option3 Value": "",
  "Variant SKU": v.sku || "",
  "Variant Grams": weightVal ? convertWeightToGrams(weightVal, weightUnit) : "",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Qty": v.inventory_level ?? 0,
        "Variant Inventory Policy": "deny",
        "Variant Fulfillment Service": "manual",
        "Variant Price": v.price != null ? v.price : p.price || 0,
        "Variant Compare At Price": p.sale_price && Number(p.sale_price) !== 0 ? p.sale_price : "",
        "Variant Requires Shipping": p.type === "digital" ? "FALSE" : "TRUE",
        "Variant Taxable": p.tax_class_id ? "TRUE" : "FALSE",
        "Variant Barcode": v.upc || "",
        "Image Src": "",
        "Image Position": "",
        "Image Alt Text": "",
        "Gift Card": "FALSE",
        "SEO Title": first ? (p.page_title || "") : "",
        "SEO Description": first ? (p.meta_description || "") : "",
        "Google Shopping / Google Product Category": "",
        "Google Shopping / Gender": "",
        "Google Shopping / Age Group": "",
        "Google Shopping / MPN": "",
        "Google Shopping / AdWords Grouping": "",
        "Google Shopping / AdWords Labels": "",
        "Google Shopping / Condition": "",
        "Google Shopping / Custom Product": "",
        "Google Shopping / Custom Label 0": "",
        "Google Shopping / Custom Label 1": "",
        "Google Shopping / Custom Label 2": "",
        "Google Shopping / Custom Label 3": "",
        "Google Shopping / Custom Label 4": "",
        "Variant Image": vImageUrl,   // <-- attach variant image to this variant row
        "Variant Weight Unit": weightVal ? weightUnit : "",
        "Variant Tax Code": "",
        "Cost per item": p.cost_price || "",
        "Price / International": "",
        "Compare At Price / International": "",
        Status: status,
        // NOTE: no "Collection" column here on purpose
      };

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const nKey = `Option${i + 1} Name`;
        const vKey = `Option${i + 1} Value`;
        row[nKey] = opt.display_name || "";
        let label = "";
        const match = v.option_values?.find((ov) => ov.option_id === opt.id);
        if (match?.label) label = match.label;
        else if (opt.option_values?.length === 1) label = opt.option_values[0].label || "Default";
        else if (options.length === 1 && variants.length === 1) label = "Default Title";
        row[vKey] = label;
      }

      rows.push(row);
      first = false;
    }

    // product-level images
    const imageRows = buildImageRows(handle, p.images || [], p.primary_image || null);
    rows.push(...imageRows);

    // Add any missing variant-only images so Shopify can import them
    if (extraVariantImageUrls.size > 0) {
      let positionStart = imageRows.length + 1;
      for (const u of extraVariantImageUrls) {
        rows.push({
          Handle: handle,
          "Image Src": u,
          "Image Position": positionStart++,
          "Image Alt Text": "",
        });
      }
    }

    // record for assignment
    productsMap.push({
      bcProductId: p.id,
      handle,
      title,
      skus: variants.map((v) => v.sku).filter(Boolean),
      categoryIds: (p.categories || []).filter(Boolean),
    });
  }

  return { rows, productsMap };
}

async function exportProductsCSV(products, categories, brands) {
  await ensureOutDir();

  categoryMap = categories.reduce((acc, c) => { if (c?.id != null) acc[c.id] = c; return acc; }, {});
  brandMap = brands.reduce((acc, b) => { if (b?.id != null) acc[b.id] = b; return acc; }, {});

  const { rows, productsMap } = buildCSVRows(products);

  const fields = [
    "Handle","Title","Body (HTML)","Vendor","Product Category","Type","Tags","Published",
    "Option1 Name","Option1 Value","Option2 Name","Option2 Value","Option3 Name","Option3 Value",
    "Variant SKU","Variant Grams","Variant Inventory Tracker","Variant Inventory Qty","Variant Inventory Policy",
    "Variant Fulfillment Service","Variant Price","Variant Compare At Price","Variant Requires Shipping",
    "Variant Taxable","Variant Barcode","Image Src","Image Position","Image Alt Text","Gift Card",
    "SEO Title","SEO Description","Google Shopping / Google Product Category","Google Shopping / Gender",
    "Google Shopping / Age Group","Google Shopping / MPN","Google Shopping / AdWords Grouping",
    "Google Shopping / AdWords Labels","Google Shopping / Condition","Google Shopping / Custom Product",
    "Google Shopping / Custom Label 0","Google Shopping / Custom Label 1","Google Shopping / Custom Label 2",
    "Google Shopping / Custom Label 3","Google Shopping / Custom Label 4","Variant Image","Variant Weight Unit",
    "Variant Tax Code","Cost per item","Price / International","Compare At Price / International","Status"
  ];

  const csv = parse(rows, { fields, excelStrings: true });
  await fs.writeFile(outPath("products-export.csv"), csv, "utf-8");
  await fs.writeFile(outPath("products-map.json"), JSON.stringify(productsMap, null, 2), "utf-8");

  console.log("✓ out/products-export.csv");
  console.log("✓ out/products-map.json");
}

// ───────────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    storeHash = process.env.BIGCOMMERCE_STORE_HASH || await prompt("BigCommerce store hash: ");
    accessToken = process.env.BIGCOMMERCE_ACCESS_TOKEN || await prompt("BigCommerce access token: ");
    defaultVendor = process.env.DEFAULT_VENDOR || await prompt("Default vendor (fallback brand): ");

    apiUrl = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog`;

    console.log("Fetching BigCommerce data…");
    const [products, categories, brands] = await Promise.all([
      fetchAllProducts(),
      fetchAllCategories(),
      fetchAllBrands(),
    ]);

    await exportProductsCSV(products, categories, brands);

    console.log("\nDone. Next steps:");
    console.log("  1) Import out/products-export.csv into Shopify (Products > Import).");
    console.log("  2) Review out/products-map.json if you need source IDs, handles, SKUs, or category IDs.");
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
})();
