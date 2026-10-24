import {Component,type ReactNode} from 'react'

/** A failed optional editor must not take down native identity or memory panels. */
export default class OptionalPanelBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false}
  static getDerivedStateFromError() {return {failed:true}}
  render() {
    return this.state.failed?<p role="alert">个人资料插件加载失败，请刷新后重试。身份和记忆功能仍可使用。</p>:this.props.children
  }
}
