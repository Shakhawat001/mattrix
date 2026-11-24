"use client"

import type { ComponentProps } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { EllipsisVerticalIcon, LayoutGridIcon, LogOutIcon, MoonIcon, SettingsIcon, SunIcon, TrendingUpIcon } from "lucide-react"
import { logout } from "@/app/(auth)/login/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { carriedQuery } from "@/lib/analytics/url"
import type { FilterApp } from "./filter-bar"

export function AppSidebar({ apps, brandName, user, ...props }: { apps: FilterApp[]; brandName: string; user: string } & ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()
  // The range and comparison follow you from page to page.
  const carry = carriedQuery(searchParams)

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!" render={<Link href={`/${carry}`} />}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
                <TrendingUpIcon strokeWidth={2.5} className="size-3.5!" aria-hidden />
              </span>
              <span className="text-base font-semibold">{brandName}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={pathname === "/"} render={<Link href={`/${carry}`} />}>
                  <LayoutGridIcon aria-hidden />
                  <span>All apps</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Apps</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {apps.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">No apps yet.</li> : null}
              {apps.map((app) => (
                <SidebarMenuItem key={app.id}>
                  <SidebarMenuButton isActive={pathname.startsWith(`/apps/${app.id}`)} render={<Link href={`/apps/${app.id}${carry}`} />}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: app.color }} aria-hidden />
                    <span>{app.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={pathname.startsWith("/settings")} render={<Link href="/settings" />}>
                  <SettingsIcon aria-hidden />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {/* Both icons are in the page; CSS picks one, so the server and browser agree. */}
                <SidebarMenuButton onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
                  <SunIcon aria-hidden className="hidden dark:block" />
                  <MoonIcon aria-hidden className="dark:hidden" />
                  <span className="dark:hidden">Dark mode</span>
                  <span className="hidden dark:inline">Light mode</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** Who is signed in, with the way out. */
function NavUser({ user }: { user: string }) {
  const { isMobile } = useSidebar()
  const avatar = (
    <Avatar className="size-8 rounded-lg" aria-hidden>
      <AvatarFallback className="rounded-lg text-xs">{user.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
  const name = (
    <span className="grid flex-1 text-left text-sm leading-tight">
      <span className="truncate font-medium">{user}</span>
      <span className="truncate text-xs text-muted-foreground">Signed in</span>
    </span>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />}>
            {avatar}
            {name}
            <EllipsisVerticalIcon className="ml-auto size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2 px-1 py-1.5 font-normal text-foreground">
                {avatar}
                {name}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <form action={logout}>
              <DropdownMenuItem nativeButton render={<button type="submit" className="w-full" />}>
                <LogOutIcon aria-hidden />
                Sign out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
