# BigCommerce Products to Shopify CSV

Export BigCommerce catalog products into Shopify's product import CSV format.

This repo intentionally includes only the product export script. It does not create Shopify collections, redirects, customers, orders, or reviews.

## What it exports

- `out/products-export.csv`: Shopify-compatible product import CSV
- `out/products-map.json`: source product IDs, Shopify handles, SKUs, and BigCommerce category IDs for follow-up work

The exporter fetches BigCommerce products, brands, and categories. Category names are used to create product tags, but no collection API calls are made.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in:

- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_ACCESS_TOKEN`
- `DEFAULT_VENDOR`

## Run

```bash
npm run export
```

Then import `out/products-export.csv` in Shopify Admin under Products > Import.

## Notes

- The script strips inline styles, empty paragraphs, and product-description images from body HTML.
- BigCommerce product image URLs are preserved for Shopify's importer.
- Products with more than three BigCommerce options are exported as drafts because Shopify CSV supports three option columns.
- The script respects BigCommerce API rate-limit headers and retries `429` responses.
