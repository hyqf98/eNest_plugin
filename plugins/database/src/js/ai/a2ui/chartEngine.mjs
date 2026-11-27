import { use } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([BarChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])
export { init } from 'echarts/core'
