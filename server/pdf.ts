import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type { Quote } from '../shared/types.ts';
import { money, materialNames } from '../shared/pricing.ts';
import { formatDate } from '../shared/dates.ts';

export function renderPdf(q: Quote, res: Response) {
  res.type('application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${q.number}-roofing-proposal.pdf"`);
  const d = new PDFDocument({size:'LETTER',margin:48,bufferPages:true,info:{Title:`${q.number} Roofing Proposal`,Author:q.company.name}});
  d.pipe(res);
  const green = '#174b3c';
  d.rect(0,0,612,10).fill(green);
  d.fillColor(green).font('Helvetica-Bold').fontSize(24).text(q.company.name,48,42);
  d.fillColor('#6b7470').font('Helvetica').fontSize(9).text([q.company.address,q.company.phone,q.company.email,q.company.license && `License: ${q.company.license}`].filter(Boolean).join('  |  '),48,d.y+8,{width:516});
  d.moveDown(2).fillColor('#1e3029').font('Helvetica-Bold').fontSize(26).text('Roofing proposal');
  d.font('Helvetica').fontSize(10).fillColor('#63716a').text(`${q.number}  |  ${q.status.toUpperCase()}  |  Created ${formatDate(q.createdAt)}  |  Valid through ${formatDate(q.validUntil)}`);
  if(q.measurement.source === 'eagleview-sandbox') d.moveDown().fillColor('#9b5600').font('Helvetica-Bold').text('SANDBOX TEST ONLY — EAGLEVIEW TEST DATA. NOT A CUSTOMER QUOTE.');
  if(q.measurement.source === 'demo') d.moveDown().fillColor('#9b5600').font('Helvetica-Bold').text('DEMONSTRATION ONLY — SYNTHETIC PROPERTY AND SAMPLE PRICING');
  if(q.status === 'draft') d.moveDown().fillColor('#9b5600').text('PRELIMINARY ESTIMATE — property, measurements and scope require review.');
  d.moveDown(1.5).fillColor('#1e3029').font('Helvetica-Bold').fontSize(13).text(q.customer.name);
  d.font('Helvetica').fontSize(11).text(q.measurement.address);
  d.fontSize(9).text([q.customer.email,q.customer.phone].filter(Boolean).join(' | '));
  d.moveDown().fontSize(11).text(`${materialNames[q.scope.material]} | ${q.calculation.surfaceAreaSqFt.toFixed(0)} sq ft roof surface | ${q.scope.pitch}/12 pitch | ${q.scope.wastePercent}% material waste`);
  d.fontSize(9).fillColor('#63716a').text(`Measurement source: ${q.measurement.source} ${q.measurement.reference ? '('+q.measurement.reference+')' : ''}. ${q.scope.areaType === 'footprint' ? 'Footprint converted once using specified pitch.' : 'Surface area used directly.'}`);
  if(q.scope.areaSqFt !== q.measurement.areaSqFt || q.scope.pitch !== q.measurement.pitch || q.scope.areaType !== q.measurement.areaType) d.text('Estimator adjusted the original measurement. Quote uses the scope values shown above.');
  d.moveDown(1.5);
  const header = () => {const y=d.y;d.rect(48,y,516,25).fill('#edf2ee');d.fillColor(green).font('Helvetica-Bold').fontSize(9).text('DESCRIPTION',58,y+8).text('QTY',338,y+8).text('RATE',410,y+8).text('AMOUNT',491,y+8);d.y=y+34;};
  header();
  for(const line of q.calculation.lines){
    if(d.y>660){d.addPage();header();}
    const y=d.y;d.fillColor('#273c32').font('Helvetica').fontSize(10).text(line.name,58,y,{width:266}).text(`${Number(line.quantity.toFixed(2))} ${line.unit}`,328,y,{width:78}).text(money(line.unitCents),408,y,{width:78}).text(money(line.totalCents),486,y,{width:68,align:'right'});
    d.moveTo(48,y+22).lineTo(564,y+22).strokeColor('#e5ebe7').stroke();d.y=y+32;
  }
  if(d.y>570)d.addPage();
  for(const [label,value] of [['Direct cost',q.calculation.subtotalCents],[`Overhead & profit (${q.scope.markupPercent}% markup)`,q.calculation.markupCents],[`Materials tax (${q.scope.taxPercent}%)`,q.calculation.taxCents]] as const){const y=d.y;d.fontSize(10).text(label,275,y,{width:200}).text(money(value),480,y,{width:74,align:'right'});d.y=y+20;}
  let y=d.y+4;d.rect(275,y,289,40).fill(green);d.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text('Proposal total',287,y+13).text(money(q.calculation.totalCents),433,y+13,{width:118,align:'right'});d.y=y+60;
  d.fillColor('#273c32').font('Helvetica-Bold').fontSize(11).text('Scope & assumptions',48,d.y);
  d.font('Helvetica').fontSize(9).text('Budget estimate for the stated roof replacement scope. Concealed damage, structural repairs, asbestos, specialty flashing, ventilation changes, gutters and solar removal/reinstallation are excluded unless expressly included. Decking is an allowance only. Verify measurements, local requirements, material specifications and final scope on site. Default rates are examples; the contractor must approve pricing and applicable taxes.',{width:516});
  if(q.notes)d.moveDown().text(q.notes,{width:516});
  if(q.measurement.notes)d.moveDown().text(`Measurement notes: ${q.measurement.notes}`,{width:516});
  const count=d.bufferedPageRange().count;
  for(let i=0;i<count;i++){d.switchToPage(i);d.fillColor('#7d8982').fontSize(8).text(`${q.number} • Prepared with Roofline`,48,745,{lineBreak:false}).text(`${i+1} / ${count}`,520,745,{lineBreak:false});}
  d.end();
}
