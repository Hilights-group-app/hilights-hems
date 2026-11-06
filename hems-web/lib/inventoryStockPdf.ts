import type { InventoryStockDocument, StockPhoto, StockRow, StockCounts } from "./inventoryStockData";
type Photo = { dataUrl: string; width: number; height: number };

async function imageData(source: string, signal: AbortSignal, request?: { photo: StockPhoto }, maxSide = 240): Promise<Photo | null> {
  if (!source || signal.aborted) return null;
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(), request ? 24000 : 10000);
  const cancel = ()=>controller.abort(); signal.addEventListener("abort",cancel,{once:true});
  try {
    let data = source;
    if (!source.startsWith("data:image/")) {
      const response = request ? await fetch("/api/inventory-pdf-photo", {
        method:"POST",credentials:"same-origin",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json","x-hems-photo-type":request.photo.recordType,"x-hems-photo-id":request.photo.recordId},
        body:JSON.stringify({imageUrl:source}),
      }) : await fetch(source,{cache:"force-cache",signal:controller.signal});
      if(!response.ok)return null;
      const blob=await response.blob();
      data=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader(),abort=()=>reader.abort();
        controller.signal.addEventListener("abort",abort,{once:true});
        const clear=()=>controller.signal.removeEventListener("abort",abort);
        reader.onerror=()=>{clear();reject(new Error("Image read failed."));};
        reader.onabort=()=>{clear();reject(new Error("Image read cancelled."));};
        reader.onload=()=>{clear();resolve(String(reader.result??""));};
        if(controller.signal.aborted){clear();reject(new Error("Image read cancelled."));return;}
        reader.readAsDataURL(blob);
      });
    }
    const img=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const value=new Image();
      const abort=()=>{value.onload=null;value.onerror=null;value.removeAttribute("src");reject(new Error("Image cancelled."));};
      const clear=()=>controller.signal.removeEventListener("abort",abort);
      controller.signal.addEventListener("abort",abort,{once:true});
      value.onload=()=>{clear();resolve(value);};value.onerror=()=>{clear();reject(new Error("Image failed."));};
      if(controller.signal.aborted){clear();reject(new Error("Image cancelled."));return;}value.src=data;
    });
    const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;if(!w||!h)return null;
    const scale=Math.min(1,maxSide/Math.max(w,h)),canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    const ctx=canvas.getContext("2d");if(!ctx)return null;ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
    return {dataUrl:canvas.toDataURL("image/jpeg",.86),width:canvas.width,height:canvas.height};
  }catch{return null;}finally{clearTimeout(timer);signal.removeEventListener("abort",cancel);}
}

/** Export-scoped deduplication and four-photo concurrency; no inventory writes. */
export async function prepareStockPhotos(rows: StockRow[], signal: AbortSignal, load = imageData) {
  const cache=new Map<string,Promise<Photo|null>>(),photos=new Map<string,Photo>(),missing:string[]=[];
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
    while(cursor<rows.length){const row=rows[cursor++],photo=row.photo;if(!photo)continue;
      let pending=cache.get(photo.imageUrl);
      if(!pending){pending=(async()=>{
        const direct=await load(photo.imageUrl,signal);if(direct)return direct;
        return /^https?:\/\//i.test(photo.imageUrl)&&!signal.aborted?load(photo.imageUrl,signal,{photo}):null;
      })().catch(()=>null);cache.set(photo.imageUrl,pending);}
      const loaded=await pending;if(loaded)photos.set(row.key,loaded);else missing.push(row.name);
    }
  }));return{photos,missing:Array.from(new Set(missing))};
}

export async function makeInventoryStockPdf(stock: InventoryStockDocument, signal: AbortSignal) {
  const [{jsPDF},{autoTable},logo,prepared]=await Promise.all([
    import("jspdf"),import("jspdf-autotable"),imageData("/logo.png",signal,undefined,640),prepareStockPhotos(stock.rows,signal),
  ]);
  const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
  if(logo){const scale=Math.min(44/logo.width,12/logo.height);pdf.addImage(logo.dataUrl,"JPEG",14,9,logo.width*scale,logo.height*scale);}
  else{pdf.setFont("helvetica","bold");pdf.setFontSize(13);pdf.text("HILIGHTS GROUP",14,17);}
  pdf.setFont("helvetica","bold");pdf.setFontSize(11);pdf.setTextColor(25,25,25);pdf.text(stock.date,196,14,{align:"right"});
  pdf.setFont("helvetica","normal");pdf.setFontSize(8);pdf.setTextColor(105,105,105);pdf.text("STOCK",196,20,{align:"right"});
  pdf.setDrawColor(220,220,220);pdf.line(14,26,196,26);
  pdf.setFont("helvetica","bold");pdf.setFontSize(17);pdf.setTextColor(20,20,20);
  const title=pdf.splitTextToSize(stock.title+" Stock",182);pdf.text(title,14,36);
  let y=36+(title.length-1)*7;
  pdf.setFont("helvetica","normal");pdf.setFontSize(9);pdf.setTextColor(95,95,95);pdf.text(stock.category,14,y+7);
  pdf.setFontSize(7);pdf.text("Generated: "+stock.generatedAt,14,y+13);y+=19;
  pdf.setFontSize(6.2);
  for(const note of stock.notes){const lines=pdf.splitTextToSize(note,182);pdf.text(lines,14,y);y+=lines.length*3+1;}
  if(!stock.rows.length){pdf.setFontSize(10);pdf.text("No equipment in this subcategory.",14,y+8);}
  const columns: {key:keyof StockCounts;label:string}[]=[{key:"total",label:"Total"},{key:"available",label:"Available"}];
  const optional: {key:keyof StockCounts;label:string}[]=[{key:"reserved",label:"Reserved"},{key:"out",label:"Out"},{key:"ksa",label:"In KSA"},{key:"repair",label:stock.chainHoist?"Failed":"Maintenance"}];
  columns.push(...optional.filter(column=>stock.rows.some(row=>(row.counts?.[column.key]??0)>0)));
  if(stock.chainHoist&&stock.rows.some(row=>(row.counts?.expired??0)>0))columns.push({key:"expired",label:"Expired"});
  const nameWidth=182-columns.length*14;
  type RichLine={text:string;bold:boolean}[];
  function richName(row: StockRow): RichLine[] {
    const parts=row.child?[row.name]:row.name.split(" - "),brand=parts.length>1?parts.shift()!:"";
    const words=[...(brand?brand.split(/\s+/).map(text=>({text,bold:true})):[]),...parts.join(" - ").split(/\s+/).filter(Boolean).map(text=>({text,bold:!brand&&!row.child}))];
    const lines:RichLine[]=[[]];let x=0;
    for(const word of words){pdf.setFont("helvetica",word.bold?"bold":"normal");
      const pieces=pdf.splitTextToSize(word.text,nameWidth-18) as string[];
      for(const piece of pieces){const gap=lines.at(-1)!.length?pdf.getTextWidth(" "):0,width=pdf.getTextWidth(piece);
        if(x+gap+width>nameWidth-18&&lines.at(-1)!.length){lines.push([]);x=0;}
        const prefix=lines.at(-1)!.length?" ":"";lines.at(-1)!.push({text:prefix+piece,bold:word.bold});x+=pdf.getTextWidth(prefix+piece);
      }
    }return lines;
  }
  type NameCell={kind:"item";row:StockRow;rich:RichLine[];small:string[]};
  type TableOptions = NonNullable<Parameters<typeof autoTable>[1]>;
  const body: NonNullable<TableOptions["body"]>=[];let previous="";
  for(const row of stock.rows){
    if(row.block!==previous){previous=row.block;const blockCell={content:previous.toUpperCase(),colSpan:columns.length+1,kind:"block",styles:{fillColor:[231,233,236] as [number,number,number],textColor:[35,35,35] as [number,number,number],fontStyle:"bold" as const,fontSize:8,minCellHeight:6,cellPadding:{left:4,top:1.6,bottom:1.6}}};body.push([blockCell]);}
    pdf.setFontSize(8);const rich=richName(row);pdf.setFont("helvetica","normal");pdf.setFontSize(6.3);
    const small=[row.detail,row.description].filter(Boolean).flatMap(value=>value.split(/\r?\n/).flatMap(line=>line?pdf.splitTextToSize(line,nameWidth-18):[""]));
    // Keep even very long multiline descriptions complete without drawing a
    // single oversized cell off the page. Stock numbers appear only once.
    const lines: ({rich:RichLine}|{small:string})[]=[...rich.map(rich=>({rich})),...small.map(small=>({small}))];
    for(let offset=0;offset<lines.length;offset+=40){
      const part=lines.slice(offset,offset+40),r=offset?{...row,key:row.key+":continued:"+offset,photo:undefined,counts:null,child:true}:row;
      const raw:NameCell={kind:"item",row:r,rich:part.flatMap(line=>"rich" in line?[line.rich]:[]),small:part.flatMap(line=>"small" in line?[line.small]:[])};
      const name={...raw,content:"",styles:{minCellHeight:Math.max(r.child&&!r.photo?9:14,raw.rich.length*3.5+raw.small.length*2.8+5)}};
      const number=(key:keyof StockCounts)=>r.counts?Number(r.counts[key].toFixed(3)).toLocaleString("en-US",{maximumFractionDigits:3})+(r.unit==="pcs"?"":" "+r.unit):"—";
      body.push([name,...columns.map(column=>({content:number(column.key)}))]);
    }
  }
  const columnStyles:NonNullable<TableOptions["columnStyles"]>={0:{cellWidth:nameWidth}};
  columns.forEach((column,index)=>{columnStyles[index+1]={cellWidth:14,halign:"right",textColor:column.key==="available"?[0,125,65]:column.key==="out"?[30,75,210]:column.key==="ksa"?[112,58,170]:column.key==="repair"?[155,85,10]:[45,45,45]};});
  if(body.length)autoTable(pdf,{startY:y+3,head:[["Equipment",...columns.map(column=>column.label)]],body,theme:"plain",
    styles:{font:"helvetica",fontSize:6.6,textColor:[45,45,45],cellPadding:2,lineColor:[233,233,233],lineWidth:{bottom:.15},overflow:"linebreak",valign:"middle"},
    headStyles:{fontSize:6.3,fontStyle:"bold",textColor:[95,95,95],fillColor:[248,249,250]},columnStyles,rowPageBreak:"avoid",margin:{left:14,right:14,top:14,bottom:15},
    didDrawCell:(data)=>{
      const raw=data.cell.raw as unknown as NameCell|{kind?:string};
      if(raw.kind==="block"){pdf.setFillColor(205,32,42);pdf.rect(data.cell.x,data.cell.y,1.2,data.cell.height,"F");return;}
      if(raw.kind!=="item"||data.column.index!==0)return;
      const name=raw as NameCell,x=data.cell.x+15;let lineY=data.cell.y+4;
      pdf.setFontSize(8);pdf.setTextColor(22,24,28);
      for(const line of name.rich){let offset=0;for(const part of line){pdf.setFont("helvetica",part.bold?"bold":"normal");pdf.text(part.text,x+offset,lineY);offset+=pdf.getTextWidth(part.text);}lineY+=3.5;}
      pdf.setFont("helvetica","normal");pdf.setFontSize(6.3);pdf.setTextColor(90,98,110);
      for(const line of name.small){pdf.text(line,x,lineY);lineY+=2.8;}
      const photo=prepared.photos.get(name.row.key);if(!photo)return;
      const box=9,bx=data.cell.x+3,by=data.cell.y+Math.max(1,(data.cell.height-box)/2),scale=Math.min(7.8/photo.width,7.8/photo.height),w=photo.width*scale,h=photo.height*scale;
      pdf.setFillColor(255,255,255);pdf.setDrawColor(226,228,232);pdf.roundedRect(bx,by,box,box,1,1,"FD");
      pdf.addImage(photo.dataUrl,"JPEG",bx+(box-w)/2,by+(box-h)/2,w,h,undefined,"FAST");
    }});
  const pageCount=pdf.getNumberOfPages();for(let page=1;page<=pageCount;page++){pdf.setPage(page);pdf.setDrawColor(225,225,225);pdf.line(14,286.5,196,286.5);pdf.setFont("helvetica","normal");pdf.setFontSize(6.5);pdf.setTextColor(118,118,118);pdf.text(`Stock | Page ${page} of ${pageCount}`,14,291);pdf.text("Hilights Group · Equipment Management System",196,291,{align:"right"});}
  return{pdf,fileName:stock.fileName,missingPhotos:prepared.missing};
}
