import type { QuotationData } from "@/lib/quotation-data";

/**
 * "Equipment Detail" — one write-up per machine/equipment item: its heading
 * and structural price, the admin-authored content block (or an
 * auto-generated spec line when no block matched), the product photo, and the
 * options table headed by the machine itself.
 *
 * Renders nothing at all for a quote with no machine sections — the gate
 * lives here rather than at the call site because "is there anything to show"
 * is this section's own question, and the same is true of every other section
 * component in this directory.
 *
 * `optionPriceVisible` is passed in rather than derived from `showOptionPrices`
 * here so the whole sheet answers the price-visibility question in exactly one
 * place (see `QuotationSheet`).
 */
export function EquipmentDetail({
  sections,
  optionPriceVisible,
}: {
  sections: QuotationData["machineSections"];
  optionPriceVisible: boolean;
}) {
  if (sections.length === 0) return null;

  return (
    <section className="pq-section">
      <h1 className="pq-section-title">Equipment Detail</h1>
      {sections.map((section) => (
        <div className="pq-machine-section" key={section.itemId}>
          {/* Title/spec + product photo are one page-break-avoidance
              unit (owner: images normally run full width right after
              the product title) — the options table that follows is
              outside this group since a long options table can
              legitimately spill onto the next page even when the
              title+image pair itself must not split (each row still
              avoids splitting on its own — see .pq-options-table td). */}
          <div className="pq-title-image-group">
            {/* Section heading — ALWAYS rendered, one consistent tier
                for every machine/equipment/software item, whether or
                not a content block matched (see
                src/lib/quotation-data.ts's `sectionTitle` — this used
                to be missing entirely for Easy-Loader/Fabric
                Pro/PathWorks sections, whose content blocks never
                carried an inline "##" heading the way machine.m-series
                happened to). Item code always follows as a muted mono
                suffix, matching the investment summary's item-name
                styling. */}
            <h2 className="pq-product-title">
              {section.sectionTitle} <span className="pq-item-code">{section.lineSummary.code}</span>
            </h2>
            {/* Structural section price (owner: EL-2020/PTW(I)/FP-180
                sections showed no price at all because their content
                blocks never carried an inline "Price: {{price}}" line
                the way machine.m-series's did) — printed for EVERY
                section, blocked or not, EXCEPT one whose matched block
                already prints its own inline price line
                (`hasInlinePrice`), which would otherwise double up. */}
            {section.sectionPrice && !section.hasInlinePrice ? (
              <div className="pq-section-price">Price: {section.sectionPrice}</div>
            ) : null}
            {section.titleBlockHtml ? (
              <div className="pq-block-body" dangerouslySetInnerHTML={{ __html: section.titleBlockHtml }} />
            ) : (
              // No admin-authored content block matched this item's
              // product (e.g. L-Series has none — see
              // src/lib/quotation-data.ts's `productBlockKey`) — render
              // a minimal auto-generated spec line underneath the
              // heading/price above instead of just leaving the
              // section bare.
              <div className="pq-block-missing pq-auto-summary">
                {section.specSentence ? (
                  <div className="pq-auto-summary-spec">{section.specSentence}</div>
                ) : null}
              </div>
            )}
            {section.lineSummary.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={section.lineSummary.image}
                alt={section.lineSummary.name}
                className="pq-machine-image"
              />
            ) : null}
          </div>
          {/* Rendered for every machine, not just one carrying
              options: the first row is the machine itself, so the
              table is never empty and the customer reads the product
              and its base price before what was added to it. The one
              machine that drops that first row is one whose price the
              option rows already carry in full (`QuotationBaseRow`),
              and there are always option rows in that case, so the
              table still never comes out empty. */}
          <table className="pq-options-table">
            <colgroup>
              <col className="pq-opt-col-icon" />
              <col className="pq-opt-col-option" />
              <col className="pq-opt-col-qty" />
              {optionPriceVisible ? <col className="pq-opt-col-price" /> : null}
            </colgroup>
            <thead>
              <tr>
                <th className="pq-opt-col-icon" aria-hidden="true" />
                <th className="pq-opt-col-option">Included options</th>
                <th className="pq-opt-col-qty">Qty</th>
                {optionPriceVisible ? <th className="pq-opt-col-price">Price</th> : null}
              </tr>
            </thead>
            <tbody>
              {section.baseRow ? (
                <tr className="pq-option-row pq-base-row">
                  <td className="pq-opt-col-icon" />
                  <td className="pq-opt-col-option">
                    <div className="pq-option-name">
                      {section.baseRow.code ? (
                        <span className="pq-option-code">{section.baseRow.code} — </span>
                      ) : null}
                      {section.baseRow.name}
                    </div>
                  </td>
                  <td className="pq-opt-col-qty">× {section.baseRow.qty}</td>
                  {optionPriceVisible ? (
                    <td className="pq-opt-col-price">{section.baseRow.price}</td>
                  ) : null}
                </tr>
              ) : null}
              {section.optionRows.map((option) => (
                <tr className="pq-option-row" key={option.id}>
                  <td className="pq-opt-col-icon">
                    {option.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={option.icon} alt="" className="pq-option-icon" />
                    ) : null}
                  </td>
                  <td className="pq-opt-col-option">
                    <div className="pq-option-name">
                      {option.code ? <span className="pq-option-code">{option.code} — </span> : null}
                      {option.name}
                    </div>
                    {option.descriptionHtml ? (
                      <div
                        className="pq-option-desc pq-block-body"
                        dangerouslySetInnerHTML={{ __html: option.descriptionHtml }}
                      />
                    ) : null}
                    {option.attributesLine ? (
                      <div className="pq-option-attrs">{option.attributesLine}</div>
                    ) : null}
                  </td>
                  <td className="pq-opt-col-qty">× {option.qty}</td>
                  {optionPriceVisible ? (
                    <td className="pq-opt-col-price">{option.price}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
