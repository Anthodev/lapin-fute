import {} from "piu/MC";
import { code, field, hex, part, clipped, stale, pages } from "./packed.js";
import { copy } from "../generated/display-copy.js";
const PAPER = "#f7f6ef", INK = "#111512", MUTED = "#59615b", RULE = "#b7bab2", BLUE = "#1769aa", WHITE = "#ffffff";
const BACKGROUNDS = ["#d9ebde", "#ffd990", "#f2b8bc", "#e0e3e5"];
const FOREGROUNDS = ["#174d31", "#683900", "#681d23", "#343b40"];
const MARKS = ["OK", "!", "X", "?"];
const REFRESH = String.fromCharCode(3,0,10,2,11,1,2,6,8,5,5,2,1,8,10,2,1,4,2,6,1,4,5,2);
const HOURGLASS = String.fromCharCode(0,0,30,3,0,31,30,3,3,3,3,7,24,3,3,7,6,9,3,6,21,9,3,6,9,14,12,4,6,18,3,7,21,18,3,7,3,24,3,7,24,24,3,7);
const CHECK = String.fromCharCode(5,14,4,4,9,18,4,4,13,14,4,4,17,10,4,4,21,6,4,4);
let fonts;
function glyph(port, color, x, y, shape) {
  for (let i = 0; i < shape.length; i += 4) port.fillColor(color, x + shape.charCodeAt(i), y + shape.charCodeAt(i+1), shape.charCodeAt(i+2), shape.charCodeAt(i+3));
}
function draw(port, text, style, color, x, y, width, height, align = 0) {
  if (!text || width <= 0 || height <= 0) return;
  const measure = port.measureString(text, fonts[style]);
  const used = Math.min(width, Math.ceil(measure.width));
  const left = align < 0 ? x : align > 0 ? x + width - used : x + Math.floor((width-used)/2);
  port.drawString(text, fonts[style], color, left, y + ((height - measure.height) >> 1), used < measure.width ? used : 0);
}
function drawBottom(port, text, style, color, x, bottom, width) {
  if (!text || width <= 0) return;
  const measure = port.measureString(text, fonts[style]);
  const used = Math.min(width, Math.ceil(measure.width));
  port.drawString(text, fonts[style], color, x, bottom-measure.height, used < measure.width ? used : 0);
}
function lines(port, text, style, color, x, y, width, height) {
  let start = 0, count = 0;
  while (start <= text.length && text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    draw(port, text.slice(start,end), style, color, x, y + count * height, width, height);
    count++; start = end + 1;
  }
  return count;
}
function lineCount(text) {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}
function chip(port, record, slot, x, y, width, height) {
  const base = record.length - 39;
  const background = "#" + record.slice(base,base+6), foreground = "#" + record.slice(base+6,base+12);
  port.fillColor(background,x,y,width,height);
  draw(port,clipped(record,slot),1,foreground,x+3,y,width-6,height);
}
function countdown(r, record, index, now, primary = false, copyRole = 0) {
  if (!record || index >= hex(record,22,1)) return "-";
  if (hex(record,31+index*9,1) === 2) return "-";
  const minutes = Math.ceil((hex(record,23+index*9,8)*1000-now)/60000);
  return minutes < 0 ? copy(r.profile,r.language,12,copyRole) : minutes === 0 ? copy(r.profile,r.language,13,copyRole) : String(minutes)+(primary ? "" : " min");
}
function source(r) { return r.detail && r.records[r.active] && r.detailId === field(r.records[r.active],0) ? r.detail : r.overview[r.active]; }
function palette(r, record) {
  const local = r.traffic && r.records[r.active] && r.trafficId === field(r.records[r.active],0) ? r.traffic : null;
  return local && (!record || hex(local,1,8) > hex(record,14,8)) ? hex(local,0,1) : record ? hex(record,13,1) : 3;
}
function outcome(r) {
  if (r.errors[r.screen]) return r.errors[r.screen];
  if (r.screen === 1 && !r.detail) return r.overviewErrors[r.active] || 0;
  return 0;
}
function exceptionalToken(r, usable) {
  if (!r.records.length || !r.key || (r.keyError & 21)) return 1;
  if (r.key === 2 || (r.keyError & 42)) return usable ? 0 : 3;
  if (r.candidate && r.candidate.kind === -1 && r.candidate.mode === 0 && r.candidate.need > 0) return 2;
  if (usable) return 0;
  if (r.pending & (1<<r.screen)) return 2;
  return outcome(r) || 7;
}
function exceptional(port,r,token) {
  const round = r.profile === 1, x = round ? 43 : 14, y = round ? 24 : 10, width = round ? 173 : 172, bottom = round ? 240 : 218;
  const titleId = token === 1 ? 31 : token === 2 ? 28 : token === 3 ? 34 : token === 4 ? 36 : token === 5 ? 38 : token === 6 ? 42 : r.screen === 2 ? 23 : 40;
  const bodyId = token === 1 ? 32 : token === 2 ? 29 : token === 3 ? 35 : token === 4 ? 37 : token === 5 ? 39 : token === 6 ? 43 : 41;
  const hintId = token === 1 ? 33 : token === 2 ? 30 : token === 6 || r.screen === 1 ? 44 : r.screen === 2 ? 45 : 46;
  draw(port,copy(r.profile,r.language,0),1,INK,x,y,width,20);
  if (token === 2) glyph(port,BLUE,x+Math.floor((width-30)/2),y+27,HOURGLASS);
  else draw(port,token === 1 || token === 3 ? "KEY" : "!",1,BLUE,x,y+27,width,34);
  const titleLines = lines(port,copy(r.profile,r.language,titleId,2),2,INK,x,y+66,width,20);
  lines(port,copy(r.profile,r.language,bodyId,3),0,INK,x,y+66+titleLines*20+5,width,16);
  const hint = copy(r.profile,r.language,hintId,4);
  lines(port,hint,0,MUTED,x,bottom-lineCount(hint)*16,width,16);
}
function clock(now,hour12) {
  const date = new Date(now), hours = date.getHours(), minutes = date.getMinutes();
  const shown = hour12 ? hours%12 || 12 : hours;
  return (shown<10?"0":"")+shown+":"+(minutes<10?"0":"")+minutes;
}
function header(port,r,now,isStale,updating) {
  const round = r.profile === 1, record = source(r);
  const invalid = r.key === 2 || (r.keyError & 42);
  let token = invalid ? 2 : !r.key || (r.keyError & 21) ? 31 : updating ? 3 : isStale ? 4 : r.screen === 1 && record ? 5+hex(record,10,1) : 1;
  if (token === 8) token = 4;
  const freshness = copy(r.profile,r.language,token,1);
  const label = r.screen === 2 ? clipped(r.records[r.active],3) : r.screen === 0 && r.focus === r.records.length
    ? copy(r.profile,r.language,8,1) : String((r.screen === 0 ? r.focus : r.active)+1)+" / "+r.records.length;
  if (round) {
    draw(port,clock(now,r.hour12),1,INK,57,9,146,18);
    draw(port,label,0,INK,57,28,73,20);
    draw(port,freshness,isStale?1:0,INK,130,28,73,20);
    port.fillColor(RULE,57,50,146,1);
  } else {
    draw(port,clock(now,r.hour12),1,INK,6,0,44,29,-1);
    draw(port,label,0,INK,50,0,72,29);
    draw(port,freshness,isStale?1:0,INK,122,0,72,29,1);
    port.fillColor(RULE,0,29,200,1);
  }
}
function overview(port,r,now) {
  const start = Math.max(0,r.focus-1), end = Math.min(r.records.length,r.focus+1), round = r.profile === 1;
  for (let i = start; i <= end; i++) {
    const relative = i-r.focus, compact = round && relative !== 0, focused = relative === 0;
    const x = round ? compact ? 54 : 30 : 6, y = round ? relative<0 ? 54 : relative>0 ? 176 : 92 : 34+(i-start)*62;
    const width = round ? compact ? 153 : 200 : 188, height = round ? compact ? 36 : 82 : 60;
    const color = focused ? WHITE : INK;
    if (focused) port.fillColor(INK,x,y,width,height);
    const record = r.records[i], summary = r.overview[i];
    if (!record) {
      const glyphX=x+Math.max(4,Math.floor(width*.15));
      glyph(port,color,glyphX,y+Math.floor((height-12)/2),REFRESH);
      draw(port,copy(r.profile,r.language,8,7),1,color,glyphX+20,y,x+width-glyphX-25,height,-1);
    } else {
      const traffic = summary ? hex(summary,13,1) : 3, mark = traffic ? MARKS[traffic] : "";
      const padding=compact?3:5, chipWidth=compact?34:42, countdownWidth=compact?36:42, markWidth=mark?13:0;
      const chipX=x+padding, chipHeight=compact?22:27, routeX=chipX+chipWidth+6;
      const routeWidth=x+width-padding-countdownWidth-markWidth-routeX-4;
      chip(port,record,compact?0:1,chipX,y+Math.floor((height-chipHeight)/2),chipWidth,chipHeight);
      draw(port,clipped(record,compact ? mark ? 7 : 6 : mark ? 5 : 4),1,color,routeX,compact?y:y+7,routeWidth,compact?height:22,-1);
      if (!compact) {
        draw(port,">",0,color,routeX,y+31,10,20,-1);
        draw(port,clipped(record,mark?10:9),0,color,routeX+10,y+31,routeWidth-10,20,-1);
      }
      draw(port,countdown(r,summary,0,now,false,compact?2:1),1,color,x+width-padding-countdownWidth-markWidth,y,countdownWidth,height,1);
      if(mark) draw(port,mark,1,color,x+width-padding-markWidth,y,markWidth,height);
    }
    if (!focused && !round) port.fillColor(RULE,x,y+height,width,1);
  }
}
function departures(port,r,now) {
  const round=r.profile===1, record=r.records[r.active], data=source(r), count=data?hex(data,22,1):0;
  let x=round?46:8,y=round?52:34,width=round?168:184,height=round?40:35;
  chip(port,record,2,x,y+6,44,27);
  draw(port,clipped(record,8),1,INK,x+52,y,width-52,20,-1);
  draw(port,">",1,MUTED,x+52,y+20,10,18,-1);
  draw(port,clipped(record,11),1,MUTED,x+62,y+20,width-62,18,-1);
  port.fillColor(RULE,x,y+height-1,width,1);
  x=round?42:8;y=round?92:70;width=round?176:184;height=round?68:66;
  if (!count) {
    const text=copy(r.profile,r.language,11,5);
    lines(port,text,1,INK,x,y+Math.max(0,Math.floor((height-lineCount(text)*16)/2)),width,16);
  } else {
    const status=hex(data,31,1), value=countdown(r,data,0,now,true), unit=status!==2 && Math.ceil((hex(data,23,8)*1000-now)/60000)>0;
    const style=unit?4:value==="-"?2:3, unitWidth=unit?Math.ceil(port.measureString("min",fonts[2]).width):0;
    const gap=unit?4:0, valueWidth=Math.min(width-unitWidth-gap,Math.ceil(port.measureString(value,fonts[style]).width));
    const left=x+Math.floor((width-valueWidth-unitWidth-gap)/2), bottom=y+height-20;
    drawBottom(port,value,style,INK,left,bottom,valueWidth);
    if(unit)drawBottom(port,"min",2,INK,left+valueWidth+gap,bottom,unitWidth);
    if(status)draw(port,copy(r.profile,r.language,13+status),1,INK,x,y+height-19,width,18);
  }
  const rows=Math.min(round?2:3,Math.max(0,count-1));
  x=round?48:8;y=round?162:137;width=round?164:184;height=round?42:51;
  const rowHeight=rows?Math.max(1,Math.floor(height/rows)):0;
  for(let i=0;i<rows;i++) {
    const status=hex(data,40+i*9,1), top=y+i*rowHeight;
    const label=status?copy(r.profile,r.language,13+status,1):i===0?copy(r.profile,r.language,10):"";
    draw(port,label,status?1:0,INK,x+2,top,Math.floor(width*.65),rowHeight,-1);
    draw(port,countdown(r,data,i+1,now),1,INK,x+Math.floor(width*.65),top,Math.ceil(width*.35)-2,rowHeight,1);
    if(i>0)port.fillColor(RULE,x,top,width,1);
  }
  const state=palette(r,data), foreground=FOREGROUNDS[state];
  x=round?42:0;y=round?208:188;width=round?176:200;height=round?38:40;
  port.fillColor(BACKGROUNDS[state],x,y,width,height);
  draw(port,MARKS[state],1,foreground,x+4,y,18,height,-1);
  draw(port,copy(r.profile,r.language,17+state,6),1,foreground,x+22,y,width-35,height,-1);
  draw(port,">",1,foreground,x+width-13,y,9,height,1);
}
function traffic(port,r) {
  const round=r.profile===1, x=round?42:10,top=round?54:34,width=round?176:180,pageTop=round?232:210;
  const document=r.traffic,state=hex(document,0,1),symbolX=x+Math.floor((width-30)/2);
  port.fillColor(BACKGROUNDS[state],symbolX,top,30,28);
  if(!state)glyph(port,FOREGROUNDS[state],symbolX,top,CHECK);
  else draw(port,MARKS[state],1,FOREGROUNDS[state],symbolX,top,30,28);
  const first=r.page*8,last=first+8;
  let fieldStart=18,lineIndex=0,drawn=0;
  for(let section=0;section<3;section++) {
    const length=hex(document,fieldStart,3),end=fieldStart+3+length;
    let start=fieldStart+3;
    if(length)while(start<=end) {
      let next=start;
      while(next<end && code(document,next)!==10)next++;
      if(lineIndex>=first && lineIndex<last) {
        draw(port,part(document,start,next),section===0?1:0,section===1?MUTED:INK,x,top+32+drawn*16,width,16);
        drawn++;
      }
      lineIndex++;start=next+1;
    }
    fieldStart=end;
  }
  const count=pages(document);
  if(count>1)draw(port,String(r.page+1)+" / "+count,1,INK,x,pageTop,width,14);
}
class DisplayBehavior extends Behavior {
  onDraw(port) {
    const r=this.state;if(!r)return;
    port.fillColor(PAPER,0,0,port.width,port.height);
    const now=Date.now();
    let usable=false,isStale=!!(r.failed&(1<<r.screen)) || !!outcome(r),updating=!!(r.pending&(1<<r.screen));
    if(r.screen===0)for(let i=0;i<r.records.length;i++) {
      if(r.overview[i] && (hex(r.overview[i],0,2)&1))usable=true;
      if(stale(r.overview[i],now) || r.overviewErrors[i])isStale=true;
    }
    else if(r.screen===1) { const record=source(r);usable=!!(record&&(hex(record,0,2)&1));isStale=isStale||stale(record,now); }
    else usable=!!r.traffic;
    const token=exceptionalToken(r,usable);
    if(token) {exceptional(port,r,token);return;}
    header(port,r,now,isStale,updating);
    if(r.screen===0)overview(port,r,now);else if(r.screen===1)departures(port,r,now);else traffic(port,r);
  }
}
class ApplicationBehavior extends Behavior {
  onPressBack(application) {
    const state = application.first.behavior.state;
    if (!state || state.screen === 0) return false;
    this.back();
    return true;
  }
}
export function createView(back) {
  fonts=[new Style({font:"14px Gothic"}),new Style({font:"bold 14px Gothic"}),new Style({font:"bold 18px Gothic"}),new Style({font:"bold 36px Gothic"}),new Style({font:"bold 40px Gothic"})];
  const port=new Port(null,{left:0,right:0,top:0,bottom:0,Behavior:DisplayBehavior});
  const application=new Application(null,{clip:true,touchCount:0,contents:[port],Behavior:ApplicationBehavior});
  application.behavior.back=back;
  return { application,render(state){port.behavior.state=state;port.invalidate();} };
}
